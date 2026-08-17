import type { Env } from '../types';
import { T, getFlag } from '../lib/db';
import { chunk, newId, safeJson } from '../lib/util';
import { makeLogger, type Logger } from '../lib/log';
import { getAi } from '../ai/provider';
import { activateIndex, buildIndex, quantise, type IndexEntry } from '../search/vector';
import { fetchFeed, type FeedType } from '../ingest/adapters';
import { upsertCatalog } from '../ingest/upsert';
import { embedText } from '../ingest/normalize';

/**
 * Cron-driven job queue (ADR-7).
 *
 * Cloudflare Queues needs a paid plan, so `vestiq_jobs` plus claim-based locking
 * gives at-least-once delivery with attempt counting and exponential backoff.
 * Every handler is idempotent, because a cron tick can be interrupted by the CPU
 * limit at any point and will simply resume on the next tick.
 */

export type JobType = 'feed_sync' | 'embed' | 'liveness' | 'collection_refresh';

export async function enqueueJob(
  env: Env,
  type: JobType,
  payload: Record<string, unknown>,
  runAfter = Date.now(),
): Promise<string> {
  const id = newId('j');
  await env.DB.prepare(
    `INSERT INTO ${T.jobs} (id, type, payload, status, run_after, created_at, updated_at)
     VALUES (?,?,?, 'queued', ?, ?, ?)`,
  )
    .bind(id, type, JSON.stringify(payload), runAfter, Date.now(), Date.now())
    .run();
  return id;
}

/** Wall-clock budget per cron tick, leaving headroom under the CPU limit. */
const TICK_BUDGET_MS = 20_000;
const LOCK_TIMEOUT_MS = 5 * 60_000;

interface JobRow {
  id: string;
  type: string;
  payload: string;
  attempts: number;
  max_attempts: number;
}

/**
 * Claim and run due jobs until the time budget is spent.
 * Claiming is a conditional UPDATE, so two overlapping ticks cannot both take
 * the same job.
 */
export async function drainJobs(env: Env, log: Logger): Promise<{ ran: number; failed: number }> {
  const started = Date.now();
  let ran = 0;
  let failed = 0;

  while (Date.now() - started < TICK_BUDGET_MS) {
    const candidate = await env.DB.prepare(
      `SELECT id, type, payload, attempts, max_attempts FROM ${T.jobs}
       WHERE status = 'queued' AND run_after <= ?
       ORDER BY run_after ASC LIMIT 1`,
    )
      .bind(Date.now())
      .first<JobRow>();

    if (!candidate) break;

    // Conditional claim: only proceed if we are the one who flipped it.
    const claim = await env.DB.prepare(
      `UPDATE ${T.jobs} SET status = 'running', locked_at = ?, attempts = attempts + 1, updated_at = ?
       WHERE id = ? AND status = 'queued'`,
    )
      .bind(Date.now(), Date.now(), candidate.id)
      .run();

    if (!claim.meta.changes) continue; // someone else took it

    try {
      await runJob(env, candidate, log);
      await env.DB.prepare(`UPDATE ${T.jobs} SET status = 'done', updated_at = ? WHERE id = ?`)
        .bind(Date.now(), candidate.id)
        .run();
      ran++;
    } catch (err) {
      failed++;
      const attempts = candidate.attempts + 1;
      const exhausted = attempts >= candidate.max_attempts;
      // Exponential backoff: 1m, 4m, 9m, 16m…
      const backoff = Math.min(60 * 60_000, attempts * attempts * 60_000);
      await env.DB.prepare(
        `UPDATE ${T.jobs} SET status = ?, run_after = ?, last_error = ?, updated_at = ? WHERE id = ?`,
      )
        .bind(
          exhausted ? 'failed' : 'queued',
          Date.now() + backoff,
          String(err).slice(0, 500),
          Date.now(),
          candidate.id,
        )
        .run();
      log.error('job failed', err, { job_id: candidate.id, type: candidate.type, attempts });
    }
  }

  // Recover jobs whose worker died mid-run.
  await env.DB.prepare(
    `UPDATE ${T.jobs} SET status = 'queued', updated_at = ?
     WHERE status = 'running' AND locked_at < ?`,
  )
    .bind(Date.now(), Date.now() - LOCK_TIMEOUT_MS)
    .run();

  return { ran, failed };
}

async function runJob(env: Env, job: JobRow, log: Logger): Promise<void> {
  const payload = safeJson<Record<string, unknown>>(job.payload, {});
  switch (job.type) {
    case 'feed_sync':
      await runFeedSync(env, String(payload.merchant_id ?? ''), log);
      break;
    case 'embed':
      await runEmbedBatch(env, log);
      break;
    case 'liveness':
      await runLivenessProbe(env, String(payload.product_id ?? ''), log);
      break;
    case 'collection_refresh':
      await refreshCollections(env, log);
      break;
    default:
      throw new Error(`unknown job type: ${job.type}`);
  }
}

// ---------------------------------------------------------------- feed sync

export async function runFeedSync(env: Env, merchantId: string, log: Logger): Promise<void> {
  if (!(await getFlag(env, 'ingestion_enabled', true))) {
    log.warn('ingestion disabled by flag');
    return;
  }

  const merchant = await env.DB.prepare(
    `SELECT m.id, m.brand_id, m.feed_url, m.feed_type, m.sync_every_min, b.name AS brand_name
     FROM ${T.merchants} m JOIN ${T.brands} b ON b.id = m.brand_id
     WHERE m.id = ?`,
  )
    .bind(merchantId)
    .first<{
      id: string;
      brand_id: string;
      feed_url: string | null;
      feed_type: string;
      sync_every_min: number;
      brand_name: string;
    }>();

  if (!merchant?.feed_url) throw new Error(`merchant ${merchantId} has no feed URL`);

  const runId = newId('fr');
  await env.DB.prepare(
    `INSERT INTO ${T.feedRuns} (id, merchant_id, brand_id, started_at, status)
     VALUES (?,?,?,?, 'running')`,
  )
    .bind(runId, merchant.id, merchant.brand_id, Date.now())
    .run();

  try {
    const { items } = await fetchFeed(merchant.feed_url, merchant.feed_type as FeedType);
    const stats = await upsertCatalog(
      env,
      { id: merchant.brand_id, name: merchant.brand_name },
      items,
    );

    const status = stats.rows_rejected > stats.rows_upserted && stats.rows_upserted === 0 ? 'partial' : 'ok';

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE ${T.feedRuns} SET finished_at = ?, status = ?, rows_in = ?, rows_upserted = ?,
           rows_skipped = ?, rows_rejected = ?, reject_reasons = ? WHERE id = ?`,
      ).bind(
        Date.now(),
        status,
        stats.rows_in,
        stats.rows_upserted,
        stats.rows_skipped,
        stats.rows_rejected,
        JSON.stringify(stats.reject_reasons),
        runId,
      ),
      env.DB.prepare(
        `UPDATE ${T.merchants} SET feed_status = 'healthy', last_sync_at = ?, next_sync_at = ? WHERE id = ?`,
      ).bind(Date.now(), Date.now() + merchant.sync_every_min * 60_000, merchant.id),
    ]);

    if (stats.needs_embedding.length) await enqueueJob(env, 'embed', {});

    log.info('feed sync ok', { brand: merchant.brand_name, ...stats, needs_embedding: stats.needs_embedding.length });
  } catch (err) {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE ${T.feedRuns} SET finished_at = ?, status = 'failed', error = ? WHERE id = ?`,
      ).bind(Date.now(), String(err).slice(0, 500), runId),
      env.DB.prepare(
        `UPDATE ${T.merchants} SET feed_status = 'failing', next_sync_at = ? WHERE id = ?`,
      ).bind(Date.now() + 60 * 60_000, merchant.id),
    ]);
    throw err;
  }
}

/** Queue every merchant whose sync window has elapsed. */
export async function scheduleDueFeeds(env: Env, log: Logger): Promise<number> {
  const res = await env.DB.prepare(
    `SELECT id FROM ${T.merchants}
     WHERE status IN ('approved','pending') AND feed_url IS NOT NULL
       AND (next_sync_at IS NULL OR next_sync_at <= ?)
     LIMIT 20`,
  )
    .bind(Date.now())
    .all<{ id: string }>();

  const due = res.results ?? [];
  for (const m of due) {
    // Push next_sync_at forward immediately so a slow queue can't enqueue the
    // same merchant on every tick.
    await env.DB.prepare(`UPDATE ${T.merchants} SET next_sync_at = ? WHERE id = ?`)
      .bind(Date.now() + 30 * 60_000, m.id)
      .run();
    await enqueueJob(env, 'feed_sync', { merchant_id: m.id });
  }
  if (due.length) log.info('feeds scheduled', { count: due.length });
  return due.length;
}

// ---------------------------------------------------------------- embeddings

const EMBED_BATCH = 96;

/**
 * Embed products that have no vector for the active model, then rebuild and
 * publish the KV index once coverage is high enough.
 *
 * The index is only *activated* at ≥90% coverage (ADR-3/ADR-5) so search never
 * queries a half-built index, which would silently return poor results rather
 * than failing loudly.
 */
export async function runEmbedBatch(env: Env, log: Logger): Promise<void> {
  const ai = await getAi(env);
  const provider = ai.embedProvider;
  if (!provider?.embedModel) {
    log.warn('no embedding provider available');
    return;
  }
  const model = provider.embedModel;

  const pending = await env.DB.prepare(
    `SELECT p.id, p.title, p.description, p.category, p.colors, p.materials, p.occasions,
            p.style_tags, b.name AS brand_name
     FROM ${T.products} p JOIN ${T.brands} b ON b.id = p.brand_id
     WHERE p.status = 'active' AND (p.embed_version IS NULL OR p.embed_version != ?)
     LIMIT ?`,
  )
    .bind(model.version, EMBED_BATCH)
    .all<Record<string, unknown>>();

  const rows = pending.results ?? [];

  if (rows.length) {
    const texts = rows.map((r) =>
      embedText(
        {
          title: String(r.title),
          description: (r.description as string) ?? null,
          category: String(r.category),
          colors: safeJson<string[]>(r.colors as string, []),
          materials: safeJson<string[]>(r.materials as string, []),
          occasions: safeJson<string[]>(r.occasions as string, []),
          style_tags: safeJson<string[]>(r.style_tags as string, []),
        } as never,
        String(r.brand_name),
      ),
    );

    const embedded = await ai.embed(texts);
    if (!embedded) throw new Error('embedding provider returned nothing');

    const statements = rows.map((r, i) => {
      const vec = quantise(embedded.vectors[i]);
      // D1 accepts ArrayBuffer for BLOB columns. A typed array is NOT accepted:
      // it gets coerced to its string form and silently stored as TEXT, which
      // produces a valid-looking row whose vector is unusable.
      const blob = vec.buffer.slice(vec.byteOffset, vec.byteOffset + vec.byteLength);
      return env.DB.prepare(
        `UPDATE ${T.products} SET embedding = ?, embed_version = ? WHERE id = ?`,
      ).bind(blob, embedded.model.version, String(r.id));
    });
    for (const batch of chunk(statements, 40)) await env.DB.batch(batch);

    log.info('embedded batch', { count: rows.length, version: model.version });

    // More to do — chain another job rather than looping past the CPU limit.
    if (rows.length === EMBED_BATCH) await enqueueJob(env, 'embed', {});
    return;
  }

  // Nothing left to embed: rebuild the KV index.
  await rebuildVectorIndex(env, model, log);
}

/**
 * Coerce whatever D1 hands back for a BLOB column into a signed int8 vector.
 *
 * Depending on driver and storage path this can arrive as an ArrayBuffer, a
 * typed array, or a plain number array — and a row written by an older, broken
 * build may be a comma-separated string. Anything that is not exactly `dim`
 * values is rejected rather than padded, because a truncated vector would score
 * confidently and wrongly.
 */
export function toInt8Vector(value: unknown, dim: number): Int8Array | null {
  if (value === null || value === undefined) return null;

  if (value instanceof ArrayBuffer) {
    return value.byteLength === dim ? new Int8Array(value) : null;
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    if (view.byteLength !== dim) return null;
    return new Int8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  }
  if (Array.isArray(value)) {
    if (value.length !== dim) return null;
    const out = new Int8Array(dim);
    for (let i = 0; i < dim; i++) {
      const n = Number(value[i]);
      if (!Number.isFinite(n)) return null;
      out[i] = n; // wraps 128..255 back to negative, as intended
    }
    return out;
  }
  if (typeof value === 'string') {
    const parts = value.split(',');
    if (parts.length !== dim) return null;
    const out = new Int8Array(dim);
    for (let i = 0; i < dim; i++) {
      const n = Number(parts[i]);
      if (!Number.isFinite(n)) return null;
      out[i] = n;
    }
    return out;
  }
  return null;
}

async function rebuildVectorIndex(
  env: Env,
  model: { version: number; dim: number; provider: string; model: string },
  log: Logger,
): Promise<void> {
  const total = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM ${T.products} WHERE status = 'active'`,
  ).first<{ n: number }>();
  const embedded = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM ${T.products} WHERE status = 'active' AND embed_version = ?`,
  )
    .bind(model.version)
    .first<{ n: number }>();

  const totalCount = Number(total?.n ?? 0);
  const embeddedCount = Number(embedded?.n ?? 0);
  if (!totalCount || !embeddedCount) return;

  const coverage = embeddedCount / totalCount;

  const res = await env.DB.prepare(
    `SELECT id, embedding FROM ${T.products}
     WHERE status = 'active' AND embed_version = ? AND embedding IS NOT NULL`,
  )
    .bind(model.version)
    .all<{ id: string; embedding: unknown }>();

  const entries: IndexEntry[] = [];
  let malformed = 0;
  for (const row of res.results ?? []) {
    const bytes = toInt8Vector(row.embedding, model.dim);
    if (!bytes) {
      malformed++;
      continue;
    }
    entries.push({ id: row.id, vector: bytes });
  }

  if (!entries.length) {
    // Never return silently here: an empty entry set means the index cannot be
    // built, and the only visible symptom would be semantic search quietly
    // disappearing. This exact case (vectors stored as TEXT) once shipped.
    log.error('vector index build aborted: no usable embeddings', undefined, {
      rows: (res.results ?? []).length,
      malformed,
      expected_dim: model.dim,
    });
    return;
  }
  if (malformed) log.warn('skipped malformed embeddings', { malformed, kept: entries.length });

  await buildIndex(env, model as never, entries);

  if (coverage >= 0.9) {
    await activateIndex(env, model.version);
    log.info('vector index activated', { version: model.version, entries: entries.length, coverage });
  } else {
    log.warn('vector index built but not activated: coverage too low', {
      coverage: Number(coverage.toFixed(3)),
      entries: entries.length,
    });
  }
}

// ---------------------------------------------------------------- liveness

/**
 * Verify a single listing still resolves. Dead links are the fastest way to lose
 * a user's trust permanently (docs/01 §1.3), so click-hot items are re-checked
 * aggressively.
 */
export async function runLivenessProbe(env: Env, productId: string, log: Logger): Promise<void> {
  if (!productId) return;
  const row = await env.DB.prepare(`SELECT id, url FROM ${T.products} WHERE id = ?`)
    .bind(productId)
    .first<{ id: string; url: string }>();
  if (!row) return;

  let alive = false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(row.url, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
      // Some storefronts reject HEAD; a 405 is not evidence of a dead product.
      alive = res.ok || res.status === 405;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    alive = false;
  }

  await env.DB.prepare(
    `UPDATE ${T.products} SET last_verified_at = ?, status = ? WHERE id = ?`,
  )
    .bind(alive ? Date.now() : Date.now(), alive ? 'active' : 'dead', row.id)
    .run();

  if (!alive) log.warn('listing dead', { product_id: row.id, url: row.url });
}

/** Queue liveness probes for the most-clicked listings. */
export async function scheduleLivenessProbes(env: Env, limit = 20): Promise<number> {
  const res = await env.DB.prepare(
    `SELECT p.id FROM ${T.products} p
     WHERE p.status = 'active'
       AND (p.last_verified_at IS NULL OR p.last_verified_at < ?)
     ORDER BY p.popularity DESC LIMIT ?`,
  )
    .bind(Date.now() - 3 * 86_400_000, limit)
    .all<{ id: string }>();

  for (const row of res.results ?? []) {
    await enqueueJob(env, 'liveness', { product_id: row.id });
  }
  return (res.results ?? []).length;
}

// ---------------------------------------------------------------- trending / decay

/**
 * Decay popularity so yesterday's hit doesn't rank forever, and recompute
 * engagement from the last 7 days of events.
 */
export async function recomputePopularity(env: Env, log: Logger): Promise<void> {
  const week = Date.now() - 7 * 86_400_000;
  await env.DB.batch([
    // Multiplicative decay applied every 4 hours ≈ half-life of ~5 days.
    env.DB.prepare(`UPDATE ${T.products} SET popularity = popularity * 0.945 WHERE popularity > 0.01`),
    env.DB.prepare(
      `UPDATE ${T.products} SET popularity = popularity + COALESCE((
         SELECT COUNT(*) * 0.5 FROM ${T.clicks} c
         WHERE c.product_id = ${T.products}.id AND c.ts > ?
       ), 0)
       WHERE id IN (SELECT DISTINCT product_id FROM ${T.clicks} WHERE ts > ?)`,
    ).bind(week, week),
  ]);
  await env.CACHE.delete('trending:queries:8');
  await env.CACHE.delete('trending:queries:10');
  log.info('popularity recomputed');
}

// ---------------------------------------------------------------- alerts

/**
 * Fire price-drop and back-in-stock alerts (U14/U15) — the retention primitive
 * the reference product lacks entirely.
 */
export async function dispatchAlerts(env: Env, log: Logger): Promise<{ fired: number }> {
  const res = await env.DB.prepare(
    `SELECT a.id, a.owner_key, a.product_id, a.kind, a.target_price, a.base_price, a.email,
            p.price, p.availability, p.title, p.slug, b.name AS brand_name
     FROM ${T.alerts} a
     JOIN ${T.products} p ON p.id = a.product_id
     JOIN ${T.brands} b ON b.id = p.brand_id
     WHERE a.status = 'armed' AND p.status = 'active'
     LIMIT 500`,
  ).all<Record<string, unknown>>();

  let fired = 0;
  const statements: D1PreparedStatement[] = [];

  for (const row of res.results ?? []) {
    const kind = String(row.kind);
    const price = Number(row.price);
    const basePrice = Number(row.base_price);
    const target = row.target_price === null ? null : Number(row.target_price);
    const availability = String(row.availability);

    const shouldFire =
      kind === 'price_drop'
        ? target !== null
          ? price <= target
          : price < basePrice
        : availability === 'in_stock';

    if (!shouldFire) continue;

    fired++;
    statements.push(
      env.DB.prepare(`UPDATE ${T.alerts} SET status = 'fired', fired_at = ? WHERE id = ?`).bind(
        Date.now(),
        String(row.id),
      ),
    );

    const email = row.email ? String(row.email) : null;
    if (email) {
      await sendAlertEmail(env, email, {
        kind,
        title: String(row.title),
        brand: String(row.brand_name),
        price,
        basePrice,
        url: `${env.SITE_URL}/p/${String(row.slug)}-${String(row.product_id)}`,
      }).catch((err) => log.error('alert email failed', err));
    }
  }

  for (const batch of chunk(statements, 40)) await env.DB.batch(batch);
  if (fired) log.info('alerts fired', { fired });
  return { fired };
}

interface AlertEmail {
  kind: string;
  title: string;
  brand: string;
  price: number;
  basePrice: number;
  url: string;
}

/**
 * Email delivery via Resend when configured. Without a key, alerts still fire
 * and are visible in /wardrobe — the feature degrades to in-app only rather
 * than breaking.
 */
async function sendAlertEmail(env: Env, to: string, alert: AlertEmail): Promise<void> {
  if (!env.RESEND_API_KEY) return;

  const rupees = (paise: number) => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;
  const subject =
    alert.kind === 'price_drop'
      ? `${alert.title} dropped to ${rupees(alert.price)}`
      : `${alert.title} is back in stock`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Vestiq <alerts@vestiq.in>',
      to,
      subject,
      text: `${alert.brand} — ${alert.title}

${
  alert.kind === 'price_drop'
    ? `Now ${rupees(alert.price)}, down from ${rupees(alert.basePrice)}.`
    : `It's available again.`
}

${alert.url}

You set this alert on Vestiq. Prices change at the brand's site — check before buying.`,
    }),
  });
  if (!res.ok) throw new Error(`resend ${res.status}`);
}

// ---------------------------------------------------------------- saved intents

/** Re-run standing searches and record how many new matches appeared (U16). */
export async function runSavedIntents(env: Env, log: Logger): Promise<number> {
  const res = await env.DB.prepare(
    `SELECT id, owner_key, query_raw, seen_ids FROM ${T.savedIntents}
     WHERE status = 'active' AND (last_run_at IS NULL OR last_run_at < ?)
     LIMIT 50`,
  )
    .bind(Date.now() - 20 * 3_600_000)
    .all<{ id: string; owner_key: string; query_raw: string; seen_ids: string }>();

  const { search } = await import('../search');
  let processed = 0;

  for (const intent of res.results ?? []) {
    try {
      const seen = new Set(safeJson<string[]>(intent.seen_ids, []));
      const results = await search(env, { query: intent.query_raw, perPage: 24, noPromoted: true });
      const fresh = results.items.filter((i) => !seen.has(i.id));

      const nextSeen = [...results.items.map((i) => i.id), ...seen].slice(0, 200);
      await env.DB.prepare(
        `UPDATE ${T.savedIntents} SET last_run_at = ?, last_count = ?, seen_ids = ? WHERE id = ?`,
      )
        .bind(Date.now(), fresh.length, JSON.stringify(nextSeen), intent.id)
        .run();
      processed++;
    } catch (err) {
      log.error('saved intent failed', err, { intent_id: intent.id });
    }
  }
  return processed;
}

// ---------------------------------------------------------------- trust scores

/**
 * Brand trust score (U19) — the moat. Deliberately composed of signals a brand
 * cannot trivially fake, and it *falls* on user-reported problems.
 */
export async function recomputeTrustScores(env: Env, log: Logger): Promise<void> {
  await env.DB.prepare(
    `UPDATE ${T.brands} SET trust_score = MAX(0, MIN(100, CAST(
        40
        + CASE WHEN has_return_policy = 1 THEN 12 ELSE 0 END
        + CASE WHEN ship_days IS NOT NULL AND ship_days <= 5 THEN 10
               WHEN ship_days IS NOT NULL AND ship_days <= 10 THEN 5 ELSE 0 END
        + CASE WHEN product_count >= 40 THEN 8
               WHEN product_count >= 10 THEN 4 ELSE 0 END
        + CASE WHEN (julianday('now') - julianday(created_at/1000, 'unixepoch')) > 180 THEN 10
               WHEN (julianday('now') - julianday(created_at/1000, 'unixepoch')) > 60 THEN 5 ELSE 0 END
        + COALESCE((
            SELECT CASE WHEN COUNT(*) = 0 THEN 12
                        WHEN SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) * 1.0 / COUNT(*) > 0.9 THEN 12
                        WHEN SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) * 1.0 / COUNT(*) > 0.6 THEN 6
                        ELSE 0 END
            FROM ${T.feedRuns} f WHERE f.brand_id = ${T.brands}.id
              AND f.started_at > (unixepoch() * 1000 - 2592000000)
          ), 12)
        - COALESCE((
            SELECT MIN(25, COUNT(*) * 3) FROM ${T.reports} r
            JOIN ${T.products} p2 ON p2.id = r.product_id
            WHERE p2.brand_id = ${T.brands}.id AND r.resolved = 0
          ), 0)
        - COALESCE((
            SELECT MIN(15, CAST(SUM(CASE WHEN p3.status = 'dead' THEN 1 ELSE 0 END) * 100.0
                  / MAX(1, COUNT(*)) AS INTEGER))
            FROM ${T.products} p3 WHERE p3.brand_id = ${T.brands}.id
          ), 0)
      AS INTEGER))),
      updated_at = unixepoch() * 1000
     WHERE status IN ('active','pending')`,
  ).run();

  // Demote listings we haven't been able to verify in three weeks.
  const demoted = await env.DB.prepare(
    `UPDATE ${T.products} SET status = 'stale'
     WHERE status = 'active' AND last_verified_at IS NOT NULL AND last_verified_at < ?`,
  )
    .bind(Date.now() - 21 * 86_400_000)
    .run();

  log.info('trust scores recomputed', { demoted: demoted.meta.changes });
}

// ---------------------------------------------------------------- collections

/**
 * Programmatic SEO collections (U29). A page is only marked indexable when it has
 * ≥12 genuinely matching live items — thin pages are a sitewide ranking risk.
 */
export async function refreshCollections(env: Env, log: Logger): Promise<void> {
  const res = await env.DB.prepare(
    `SELECT id, filters FROM ${T.collections} WHERE status = 'active' LIMIT 200`,
  ).all<{ id: string; filters: string }>();

  const { search } = await import('../search');
  for (const row of res.results ?? []) {
    try {
      const filters = safeJson<Record<string, unknown>>(row.filters, {});
      const { heuristicParse } = await import('../ai/heuristic');
      const parse = { ...heuristicParse(''), ...filters, confidence: 0.9 } as never;
      const results = await search(env, { query: '', parse, perPage: 1, noPromoted: true });

      await env.DB.prepare(
        `UPDATE ${T.collections} SET item_count = ?, indexable = ?, updated_at = ? WHERE id = ?`,
      )
        .bind(results.total, results.total >= 12 ? 1 : 0, Date.now(), row.id)
        .run();
    } catch (err) {
      log.error('collection refresh failed', err, { collection_id: row.id });
    }
  }
  log.info('collections refreshed', { count: (res.results ?? []).length });
}

// ---------------------------------------------------------------- cron entry

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Scheduled tasks, dispatched from one cron trigger.
 *
 * The Workers Free plan caps cron triggers at 5 per *account*, shared with every
 * other Worker on it, so this Worker uses exactly one and decides internally
 * what is due. Each task records its own last-run marker in KV, which makes the
 * schedule self-healing: a tick that is skipped, throttled, or killed by the CPU
 * limit is simply picked up by the next one, rather than waiting a full day for
 * a fixed expression to come round again.
 *
 * Order matters — cheap, latency-sensitive work first, so that if the tick runs
 * out of budget it is always the heavy maintenance that gets deferred.
 */
interface ScheduledTask {
  name: string;
  everyMs: number;
  run: (env: Env, log: Logger) => Promise<unknown>;
}

export const SCHEDULED_TASKS: ScheduledTask[] = [
  { name: 'jobs_drain', everyMs: 15 * MINUTE, run: (env, log) => drainJobs(env, log) },
  { name: 'feeds', everyMs: 30 * MINUTE, run: (env, log) => scheduleDueFeeds(env, log) },
  { name: 'liveness', everyMs: HOUR, run: (env) => scheduleLivenessProbes(env) },
  { name: 'popularity', everyMs: 4 * HOUR, run: (env, log) => recomputePopularity(env, log) },
  { name: 'alerts', everyMs: 12 * HOUR, run: (env, log) => dispatchAlerts(env, log) },
  { name: 'saved_intents', everyMs: 24 * HOUR, run: (env, log) => runSavedIntents(env, log) },
  { name: 'trust', everyMs: 24 * HOUR, run: (env, log) => recomputeTrustScores(env, log) },
  { name: 'collections', everyMs: 24 * HOUR, run: (env, log) => refreshCollections(env, log) },
  { name: 'weekly', everyMs: 7 * 24 * HOUR, run: (env, log) => weeklyMaintenance(env, log) },
];

/** Wall-clock budget for one tick, leaving headroom for the current task. */
const SCHEDULE_BUDGET_MS = 25_000;

const markerKey = (name: string) => `cron:last:${name}`;

export async function handleScheduled(event: ScheduledController, env: Env): Promise<void> {
  const log = makeLogger(`cron-${event.scheduledTime}`, env.LOG_LEVEL).child({
    cron: event.cron,
    trigger: 'cron',
  });
  await runScheduledTasks(env, log);
}

/**
 * Run whatever is due. Called by the cron handler and, when no cron slot is
 * available on the account, by `POST /admin/jobs/tick` from an external
 * scheduler (see .github/workflows/scheduler.yml). Both paths are identical, so
 * moving between them changes nothing about behaviour.
 */
export async function runScheduledTasks(
  env: Env,
  log: Logger,
  budgetMs: number = SCHEDULE_BUDGET_MS,
): Promise<{ ran: string[]; skipped: string[]; ms: number }> {
  const started = Date.now();
  const ran: string[] = [];
  const skipped: string[] = [];

  for (const task of SCHEDULED_TASKS) {
    if (Date.now() - started > budgetMs) {
      skipped.push(task.name);
      continue;
    }

    let last = 0;
    try {
      const raw = await env.CACHE.get(markerKey(task.name));
      last = raw ? parseInt(raw, 10) || 0 : 0;
    } catch {
      // A KV read failure means we may run a task early. That is safe: every
      // task is idempotent. Failing closed would silently stop all maintenance.
    }

    if (Date.now() - last < task.everyMs) continue;

    // Claim before running so an overlapping tick doesn't duplicate the work.
    try {
      await env.CACHE.put(markerKey(task.name), String(Date.now()), {
        expirationTtl: Math.max(60, Math.ceil((task.everyMs * 3) / 1000)),
      });
    } catch {
      /* proceed anyway; duplicate work is tolerable, missed work is not */
    }

    try {
      await task.run(env, log);
      ran.push(task.name);
    } catch (err) {
      // One failing task must not prevent the others from running.
      log.error('scheduled task failed', err, { task: task.name });
    }
  }

  const ms = Date.now() - started;
  log.info('scheduler tick complete', { ran, skipped, ms });
  return { ran, skipped, ms };
}

async function weeklyMaintenance(env: Env, log: Logger): Promise<void> {
  await env.DB.batch([
    // Reset exhausted campaigns that have budget headroom again.
    env.DB.prepare(
      `UPDATE ${T.promotions} SET status = 'active'
       WHERE status = 'exhausted' AND spent_paise < budget_paise`,
    ),
    // Bound table growth on the free tier.
    env.DB.prepare(`DELETE FROM ${T.events} WHERE ts < ?`).bind(Date.now() - 90 * 86_400_000),
    env.DB.prepare(`DELETE FROM ${T.searches} WHERE ts < ?`).bind(Date.now() - 180 * 86_400_000),
    env.DB.prepare(`DELETE FROM ${T.jobs} WHERE status = 'done' AND updated_at < ?`).bind(
      Date.now() - 7 * 86_400_000,
    ),
    env.DB.prepare(`DELETE FROM ${T.priceHistory} WHERE ts < ?`).bind(
      Date.now() - 365 * 86_400_000,
    ),
  ]);
  log.info('weekly maintenance done');
}

// ---------------------------------------------------------------- piggyback driver

/**
 * Traffic-driven scheduling — the third and last-resort driver.
 *
 * This account has no free Cloudflare cron slots left, and GitHub Actions is
 * unavailable when Actions billing is blocked. Rather than leave maintenance with
 * no driver at all, a small share of ordinary requests carries it: after the
 * response is sent, one request per interval runs whatever is due.
 *
 * Properties that make this safe:
 *   - it runs in `waitUntil`, so it never delays a user's response;
 *   - a KV claim means exactly one request per interval does the work;
 *   - the budget is small (5s wall, almost all of it I/O wait rather than CPU),
 *     and every task is idempotent and resumable, so being cut short mid-run
 *     simply defers the remainder to the next carrier request.
 *
 * Its one real weakness: no traffic means no maintenance. That is acceptable for
 * a site whose maintenance exists to serve traffic, but it is why a real cron
 * trigger remains the preferred driver (docs/07-deployment.md).
 */
const PIGGYBACK_KEY = 'cron:driver:last';
const PIGGYBACK_INTERVAL_MS = 15 * MINUTE;
const PIGGYBACK_BUDGET_MS = 5_000;

export async function maybeRunScheduledFromRequest(env: Env, log: Logger): Promise<void> {
  if (env.SCHEDULER_PIGGYBACK !== '1') return;
  try {
    const raw = await env.CACHE.get(PIGGYBACK_KEY);
    const last = raw ? parseInt(raw, 10) || 0 : 0;
    if (Date.now() - last < PIGGYBACK_INTERVAL_MS) return;

    // Claim before doing any work so concurrent requests don't pile on.
    await env.CACHE.put(PIGGYBACK_KEY, String(Date.now()), {
      expirationTtl: Math.ceil((PIGGYBACK_INTERVAL_MS * 3) / 1000),
    });

    await runScheduledTasks(env, log.child({ trigger: 'piggyback' }), PIGGYBACK_BUDGET_MS);
  } catch (err) {
    // Never let background scheduling affect the request that carried it.
    log.error('piggyback scheduling failed', err);
  }
}
