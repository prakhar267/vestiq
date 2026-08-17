import { Hono } from 'hono';
import type { AppContext, Env } from '../types';
import { T, audit, getFlag, setFlag } from '../lib/db';
import { esc, formatINR, safeEqual, timeAgo, truncate } from '../lib/util';
import { layout } from '../ui/layout';
import { sectionHead } from '../ui/components';

type Ctx = { Bindings: Env; Variables: { app: AppContext } };

export const adminRoutes = new Hono<Ctx>();

const COOKIE = 'vq_admin';

/**
 * Admin auth: a single shared secret in `ADMIN_TOKEN`, compared in constant
 * time. Deliberately minimal — a full user/role system for a one-operator
 * console would be more attack surface than it removes. Every mutation is
 * audit-logged.
 */
function isAuthed(c: { env: Env; req: { header: (k: string) => string | undefined } }): boolean {
  const expected = c.env.ADMIN_TOKEN;
  if (!expected || expected.length < 16) return false; // refuse to run unconfigured

  const header = c.req.header('authorization');
  if (header?.startsWith('Bearer ') && safeEqual(header.slice(7), expected)) return true;

  const cookie = c.req.header('cookie') ?? '';
  const match = /(?:^|;\s*)vq_admin=([^;]+)/.exec(cookie);
  if (match && safeEqual(decodeURIComponent(match[1]), expected)) return true;

  return false;
}

adminRoutes.use('/admin/*', async (c, next) => {
  if (c.req.path === '/admin/login' || c.req.path === '/admin') return next();
  if (!isAuthed(c)) return c.redirect('/admin/login', 302);
  return next();
});

function shell(c: { env: Env; var: { app: AppContext } }, title: string, body: string): string {
  return layout(
    {
      env: c.env,
      title: `${title} — Admin`,
      description: 'Vestiq operations console',
      path: '/admin',
      nonce: c.var.app.nonce,
      noindex: true,
    },
    `<div class="wrap"><section class="section">
      <nav class="chips" style="margin-bottom:var(--s6)">
        <a class="chip" href="/admin">Overview</a>
        <a class="chip" href="/admin/queries">Query gaps</a>
        <a class="chip" href="/admin/brands">Brands</a>
        <a class="chip" href="/admin/feeds">Feeds</a>
        <a class="chip" href="/admin/reports">Reports</a>
        <a class="chip" href="/admin/flags">Flags</a>
      </nav>
      ${body}
    </section></div>`,
  );
}

adminRoutes.get('/admin/login', (c) =>
  c.html(
    shell(
      c,
      'Login',
      `<h1>Admin</h1>
      ${!c.env.ADMIN_TOKEN ? '<div class="notice bad">ADMIN_TOKEN is not set. Run: wrangler secret put ADMIN_TOKEN</div>' : ''}
      <form method="POST" action="/admin/login" style="max-width:420px;margin-top:var(--s5)">
        <label class="field"><span>Admin token</span>
          <input type="password" name="token" autocomplete="current-password" required></label>
        <button class="btn btn-primary btn-block" type="submit">Sign in</button>
      </form>`,
    ),
  ),
);

adminRoutes.post('/admin/login', async (c) => {
  const form = await c.req.formData();
  const token = String(form.get('token') ?? '');
  const expected = c.env.ADMIN_TOKEN ?? '';

  if (!expected || !safeEqual(token, expected)) {
    await audit(c.env, 'anonymous', 'admin_login_failed', undefined, {}, c.req.header('cf-connecting-ip'));
    return c.html(shell(c, 'Login', `<div class="notice bad">Invalid token.</div>`), 401);
  }

  await audit(c.env, 'admin', 'admin_login', undefined, {}, c.req.header('cf-connecting-ip'));
  const secure = new URL(c.req.url).protocol === 'https:';
  // SameSite=Strict: the admin console is never legitimately reached by a
  // cross-site navigation, so this closes off CSRF on the mutation routes.
  c.header(
    'set-cookie',
    `${COOKIE}=${encodeURIComponent(token)}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=43200${secure ? '; Secure' : ''}`,
  );
  return c.redirect('/admin', 302);
});

adminRoutes.get('/admin', async (c) => {
  if (!isAuthed(c)) return c.redirect('/admin/login', 302);

  const day = Date.now() - 86_400_000;
  const week = Date.now() - 7 * 86_400_000;

  const [products, brands, searches, zeroRate, clicks, revenue, staleCount] = await Promise.all([
    one(c.env, `SELECT COUNT(*) AS n FROM ${T.products} WHERE status = 'active'`),
    one(c.env, `SELECT COUNT(*) AS n FROM ${T.brands} WHERE status = 'active'`),
    one(c.env, `SELECT COUNT(*) AS n FROM ${T.searches} WHERE ts > ?`, [day]),
    one(
      c.env,
      `SELECT ROUND(100.0 * SUM(CASE WHEN result_count = 0 THEN 1 ELSE 0 END) / MAX(1, COUNT(*)), 1) AS n
       FROM ${T.searches} WHERE ts > ?`,
      [week],
    ),
    one(c.env, `SELECT COUNT(*) AS n FROM ${T.clicks} WHERE ts > ?`, [day]),
    one(
      c.env,
      `SELECT COALESCE(SUM(commission), 0) + COALESCE(SUM(cpc_paise), 0) AS n
       FROM ${T.clicks} WHERE ts > ?`,
      [week],
    ),
    one(
      c.env,
      `SELECT COUNT(*) AS n FROM ${T.products}
       WHERE status = 'active' AND (last_verified_at IS NULL OR last_verified_at < ?)`,
      [week],
    ),
  ]);

  const bounce = await one(
    c.env,
    `SELECT ROUND(100.0 * SUM(CASE WHEN returned_at IS NOT NULL AND returned_at - ts < 10000 THEN 1 ELSE 0 END)
       / MAX(1, COUNT(*)), 1) AS n FROM ${T.clicks} WHERE ts > ?`,
    [week],
  );

  return c.html(
    shell(
      c,
      'Overview',
      `<h1>Overview</h1>
      <div class="stat-row" style="margin-top:var(--s6)">
        ${stat('Live SKUs', products.toLocaleString('en-IN'))}
        ${stat('Live brands', brands.toLocaleString('en-IN'))}
        ${stat('Searches 24h', searches.toLocaleString('en-IN'))}
        ${stat('Zero-result 7d', `${zeroRate}%`, zeroRate > 3 ? 'bad' : 'good')}
        ${stat('Hop-outs 24h', clicks.toLocaleString('en-IN'))}
        ${stat('10s bounce-back', `${bounce}%`, bounce > 25 ? 'bad' : 'good')}
        ${stat('Revenue 7d', formatINR(revenue))}
        ${stat('Stale listings', staleCount.toLocaleString('en-IN'), staleCount > products * 0.1 ? 'warn' : 'good')}
      </div>
      <p class="tiny">Targets from docs/01-product.md §7: zero-result &lt; 3%, bounce-back &lt; 25%.</p>`,
    ),
  );
});

/** Zero-result and zero-click queries — this list *is* the supply roadmap. */
adminRoutes.get('/admin/queries', async (c) => {
  const week = Date.now() - 7 * 86_400_000;
  const zero = await c.env.DB.prepare(
    `SELECT query_raw, COUNT(*) AS n, MAX(ts) AS last_ts
     FROM ${T.searches} WHERE ts > ? AND result_count = 0
     GROUP BY query_hash ORDER BY n DESC LIMIT 60`,
  )
    .bind(week)
    .all<{ query_raw: string; n: number; last_ts: number }>();

  const thin = await c.env.DB.prepare(
    `SELECT query_raw, COUNT(*) AS n, AVG(result_count) AS avg_results
     FROM ${T.searches} WHERE ts > ? AND result_count BETWEEN 1 AND 5
     GROUP BY query_hash ORDER BY n DESC LIMIT 40`,
  )
    .bind(week)
    .all<{ query_raw: string; n: number; avg_results: number }>();

  return c.html(
    shell(
      c,
      'Query gaps',
      `<h1>Query gaps</h1>
      <p class="muted">What people asked for and we couldn't serve. Each row is a brand to go sign.</p>
      ${sectionHead('Zero results')}
      <div class="table-wrap"><table>
        <thead><tr><th>Query</th><th class="num">Times</th><th>Last seen</th><th></th></tr></thead>
        <tbody>${(zero.results ?? [])
          .map(
            (r) => `<tr>
              <td>${esc(truncate(r.query_raw, 70))}</td>
              <td class="num">${r.n}</td>
              <td>${esc(timeAgo(r.last_ts))}</td>
              <td><a href="/search?q=${encodeURIComponent(r.query_raw)}">check</a></td>
            </tr>`,
          )
          .join('') || '<tr><td colspan="4" class="muted">Nothing — good.</td></tr>'}</tbody>
      </table></div>
      ${sectionHead('Thin results (1–5)')}
      <div class="table-wrap"><table>
        <thead><tr><th>Query</th><th class="num">Times</th><th class="num">Avg results</th></tr></thead>
        <tbody>${(thin.results ?? [])
          .map(
            (r) => `<tr><td>${esc(truncate(r.query_raw, 70))}</td>
              <td class="num">${r.n}</td><td class="num">${r.avg_results.toFixed(1)}</td></tr>`,
          )
          .join('') || '<tr><td colspan="3" class="muted">None.</td></tr>'}</tbody>
      </table></div>`,
    ),
  );
});

adminRoutes.get('/admin/brands', async (c) => {
  const res = await c.env.DB.prepare(
    `SELECT b.id, b.name, b.slug, b.status, b.trust_score, b.product_count, b.domain,
            m.email, m.feed_status, m.last_sync_at
     FROM ${T.brands} b LEFT JOIN ${T.merchants} m ON m.brand_id = b.id
     ORDER BY CASE b.status WHEN 'pending' THEN 0 ELSE 1 END, b.created_at DESC LIMIT 200`,
  ).all<Record<string, unknown>>();

  return c.html(
    shell(
      c,
      'Brands',
      `<h1>Brands</h1>
      <div class="table-wrap"><table>
        <thead><tr><th>Brand</th><th>Status</th><th class="num">Trust</th><th class="num">SKUs</th>
          <th>Feed</th><th>Synced</th><th>Action</th></tr></thead>
        <tbody>${(res.results ?? [])
          .map(
            (b) => `<tr>
              <td><a href="/brand/${esc(String(b.slug))}">${esc(String(b.name))}</a>
                <div class="tiny">${esc(String(b.domain ?? ''))}</div></td>
              <td><span class="badge ${b.status === 'active' ? 'good' : b.status === 'pending' ? 'warn' : 'bad'}">${esc(String(b.status))}</span></td>
              <td class="num">${Number(b.trust_score)}</td>
              <td class="num">${Number(b.product_count)}</td>
              <td><span class="badge ${b.feed_status === 'healthy' ? 'good' : b.feed_status === 'failing' ? 'bad' : ''}">${esc(String(b.feed_status ?? '—'))}</span></td>
              <td>${esc(b.last_sync_at ? timeAgo(Number(b.last_sync_at)) : '—')}</td>
              <td>
                <form method="POST" action="/admin/brands/${esc(String(b.id))}/status" style="display:inline">
                  <select name="status" data-autosubmit>
                    ${['active', 'pending', 'suspended']
                      .map(
                        (s) =>
                          `<option value="${s}"${b.status === s ? ' selected' : ''}>${s}</option>`,
                      )
                      .join('')}
                  </select>
                  <noscript><button class="btn btn-sm" type="submit">Set</button></noscript>
                </form>
              </td>
            </tr>`,
          )
          .join('')}</tbody>
      </table></div>`,
    ),
  );
});

adminRoutes.post('/admin/brands/:id/status', async (c) => {
  const id = c.req.param('id');
  const form = await c.req.formData();
  const status = String(form.get('status') ?? '');
  if (!['active', 'pending', 'suspended'].includes(status)) return c.text('bad status', 400);

  await c.env.DB.prepare(`UPDATE ${T.brands} SET status = ?, updated_at = ? WHERE id = ?`)
    .bind(status, Date.now(), id)
    .run();
  await audit(c.env, 'admin', 'brand_status', id, { status }, c.req.header('cf-connecting-ip'));
  return c.redirect('/admin/brands', 302);
});

adminRoutes.get('/admin/feeds', async (c) => {
  const res = await c.env.DB.prepare(
    `SELECT f.*, b.name AS brand_name FROM ${T.feedRuns} f
     JOIN ${T.brands} b ON b.id = f.brand_id
     ORDER BY f.started_at DESC LIMIT 80`,
  ).all<Record<string, unknown>>();

  const jobs = await c.env.DB.prepare(
    `SELECT type, status, COUNT(*) AS n FROM ${T.jobs} GROUP BY type, status ORDER BY n DESC LIMIT 20`,
  ).all<{ type: string; status: string; n: number }>();

  return c.html(
    shell(
      c,
      'Feeds',
      `<h1>Ingestion</h1>
      ${sectionHead('Job queue')}
      <div class="table-wrap"><table>
        <thead><tr><th>Type</th><th>Status</th><th class="num">Count</th></tr></thead>
        <tbody>${(jobs.results ?? [])
          .map(
            (j) =>
              `<tr><td>${esc(j.type)}</td><td><span class="badge ${j.status === 'failed' ? 'bad' : ''}">${esc(j.status)}</span></td><td class="num">${j.n}</td></tr>`,
          )
          .join('') || '<tr><td colspan="3" class="muted">Queue empty.</td></tr>'}</tbody>
      </table></div>
      ${sectionHead('Recent runs')}
      <div class="table-wrap"><table>
        <thead><tr><th>Brand</th><th>Started</th><th>Status</th><th class="num">In</th>
          <th class="num">Upserted</th><th class="num">Rejected</th><th>Reasons</th></tr></thead>
        <tbody>${(res.results ?? [])
          .map(
            (f) => `<tr>
              <td>${esc(String(f.brand_name))}</td>
              <td>${esc(timeAgo(Number(f.started_at)))}</td>
              <td><span class="badge ${f.status === 'ok' ? 'good' : f.status === 'failed' ? 'bad' : 'warn'}">${esc(String(f.status))}</span></td>
              <td class="num">${Number(f.rows_in)}</td>
              <td class="num">${Number(f.rows_upserted)}</td>
              <td class="num">${Number(f.rows_rejected)}</td>
              <td class="tiny">${esc(truncate(String(f.reject_reasons ?? '{}'), 60))}</td>
            </tr>`,
          )
          .join('') || '<tr><td colspan="7" class="muted">No runs yet.</td></tr>'}</tbody>
      </table></div>`,
    ),
  );
});

adminRoutes.get('/admin/reports', async (c) => {
  const res = await c.env.DB.prepare(
    `SELECT r.*, p.title, p.slug, b.name AS brand_name
     FROM ${T.reports} r
     JOIN ${T.products} p ON p.id = r.product_id
     JOIN ${T.brands} b ON b.id = p.brand_id
     WHERE r.resolved = 0 ORDER BY r.ts DESC LIMIT 100`,
  ).all<Record<string, unknown>>();

  return c.html(
    shell(
      c,
      'Reports',
      `<h1>Reported listings</h1>
      <div class="table-wrap"><table>
        <thead><tr><th>Product</th><th>Brand</th><th>Reason</th><th>When</th><th>Action</th></tr></thead>
        <tbody>${(res.results ?? [])
          .map(
            (r) => `<tr>
              <td><a href="/p/${esc(String(r.slug))}-${esc(String(r.product_id))}">${esc(truncate(String(r.title), 44))}</a></td>
              <td>${esc(String(r.brand_name))}</td>
              <td>${esc(String(r.reason))}</td>
              <td>${esc(timeAgo(Number(r.ts)))}</td>
              <td><form method="POST" action="/admin/reports/${esc(String(r.id))}/resolve">
                <button class="btn btn-sm" type="submit">Resolve</button></form></td>
            </tr>`,
          )
          .join('') || '<tr><td colspan="5" class="muted">Nothing reported.</td></tr>'}</tbody>
      </table></div>`,
    ),
  );
});

adminRoutes.post('/admin/reports/:id/resolve', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare(`UPDATE ${T.reports} SET resolved = 1 WHERE id = ?`).bind(id).run();
  await audit(c.env, 'admin', 'report_resolved', id);
  return c.redirect('/admin/reports', 302);
});

/** Kill switches. The point of these is that they work when AI is on fire. */
const FLAGS = [
  { key: 'ai_parse_enabled', label: 'AI query parsing', help: 'Off = heuristic parser only.' },
  { key: 'vector_search_enabled', label: 'Semantic search', help: 'Off = lexical only.' },
  { key: 'stylist_enabled', label: 'Stylist chat', help: 'Off = /stylist shows a notice.' },
  { key: 'promoted_enabled', label: 'Promoted placements', help: 'Off = fully organic results.' },
  { key: 'ingestion_enabled', label: 'Feed ingestion', help: 'Off = cron skips feed syncs.' },
];

adminRoutes.get('/admin/flags', async (c) => {
  const values = await Promise.all(FLAGS.map((f) => getFlag(c.env, f.key, true)));
  return c.html(
    shell(
      c,
      'Flags',
      `<h1>Feature flags</h1>
      <p class="muted">Kill switches. Changes take effect within 60 seconds.</p>
      <form method="POST" action="/admin/flags" style="margin-top:var(--s6);max-width:560px">
        ${FLAGS.map(
          (f, i) => `<label class="field" style="display:flex;gap:var(--s3);align-items:flex-start">
            <input type="checkbox" name="${esc(f.key)}" value="1"${values[i] ? ' checked' : ''} style="margin-top:4px">
            <span><strong>${esc(f.label)}</strong><br><span class="tiny">${esc(f.help)}</span></span>
          </label>`,
        ).join('')}
        <button class="btn btn-primary" type="submit">Save flags</button>
      </form>`,
    ),
  );
});

adminRoutes.post('/admin/flags', async (c) => {
  const form = await c.req.formData();
  for (const f of FLAGS) {
    await setFlag(c.env, f.key, form.get(f.key) === '1');
  }
  await audit(c.env, 'admin', 'flags_updated', undefined, {
    flags: FLAGS.map((f) => `${f.key}=${form.get(f.key) === '1'}`),
  });
  return c.redirect('/admin/flags', 302);
});

// ---------------------------------------------------------------- job control

/**
 * Manual job triggers. Cron owns the normal schedule; these exist so operations
 * (and `npm run embed`) can force work without waiting up to 15 minutes, which
 * matters during a first deploy and during incidents.
 */
adminRoutes.post('/admin/jobs/:action', async (c) => {
  const action = c.req.param('action');
  const { drainJobs, enqueueJob, recomputeTrustScores, refreshCollections, scheduleDueFeeds, recomputePopularity, dispatchAlerts } =
    await import('../jobs');
  const { makeLogger } = await import('../lib/log');
  const log = makeLogger(c.var.app.requestId, c.env.LOG_LEVEL);

  await audit(c.env, 'admin', 'job_triggered', action, {}, c.req.header('cf-connecting-ip'));

  switch (action) {
    // Full scheduler tick. Used by the external scheduler when no Cloudflare
    // cron slot is available (see docs/07-deployment.md).
    case 'tick': {
      const { runScheduledTasks } = await import('../jobs');
      const result = await runScheduledTasks(c.env, log);
      return c.json({ ok: true, action, ...result });
    }
    case 'embed': {
      await enqueueJob(c.env, 'embed', {});
      const result = await drainJobs(c.env, log);
      // Report real coverage, not just how many jobs ran: the caller loops until
      // `pending` reaches zero, and `ran` is always ≥1 because we just enqueued.
      const { EMBED_MODELS } = await import('../ai/provider');
      const version = c.env.GEMINI_API_KEY
        ? EMBED_MODELS.gemini.version
        : EMBED_MODELS['workers-ai'].version;
      const counts = await c.env.DB.prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN embed_version = ? THEN 1 ELSE 0 END) AS embedded
         FROM ${T.products} WHERE status = 'active'`,
      )
        .bind(version)
        .first<{ total: number; embedded: number }>();
      const total = Number(counts?.total ?? 0);
      const embedded = Number(counts?.embedded ?? 0);
      const indexActive = (await c.env.VECTORS.get('vec:active')) !== null;
      return c.json({
        ok: true,
        action,
        ...result,
        total,
        embedded,
        pending: Math.max(0, total - embedded),
        index_active: indexActive,
      });
    }
    case 'feeds': {
      const scheduled = await scheduleDueFeeds(c.env, log);
      const result = await drainJobs(c.env, log);
      return c.json({ ok: true, action, scheduled, ...result });
    }
    case 'drain': {
      const result = await drainJobs(c.env, log);
      return c.json({ ok: true, action, ...result });
    }
    case 'trust':
      await recomputeTrustScores(c.env, log);
      return c.json({ ok: true, action });
    case 'collections':
      await refreshCollections(c.env, log);
      return c.json({ ok: true, action });
    case 'popularity':
      await recomputePopularity(c.env, log);
      return c.json({ ok: true, action });
    case 'alerts': {
      const result = await dispatchAlerts(c.env, log);
      return c.json({ ok: true, action, ...result });
    }
    default:
      return c.json({ error: 'unknown action' }, 400);
  }
});

// ---------------------------------------------------------------- helpers

async function one(env: Env, sql: string, binds: unknown[] = []): Promise<number> {
  try {
    const row = await env.DB.prepare(sql)
      .bind(...binds)
      .first<{ n: number | null }>();
    return Number(row?.n ?? 0);
  } catch {
    return 0;
  }
}

function stat(label: string, value: string, tone?: 'good' | 'warn' | 'bad'): string {
  return `<div class="stat">
    <div class="label">${esc(label)}</div>
    <div class="value${tone ? ` ${tone}` : ''}" style="${tone === 'bad' ? 'color:var(--bad)' : tone === 'warn' ? 'color:var(--warn)' : ''}">${esc(value)}</div>
  </div>`;
}
