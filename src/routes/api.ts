import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext, Env, ResultItem } from '../types';
import { PRODUCT_COLUMNS, T, inClause, rowToProduct } from '../lib/db';
import { esc, newId, normaliseQuery, sha256Hex, truncate } from '../lib/util';
import { ownerKey, pushRecentQuery, saveSession } from '../lib/session';
import { rateIdentity, rateLimit, rateLimitHeaders } from '../lib/ratelimit';
import { getAi, STYLIST_SYSTEM_PROMPT, type ChatMessage } from '../ai/provider';
import { search } from '../search';
import { productGrid } from '../ui/components';
import { applyUrlFilters } from './pages';

type Ctx = { Bindings: Env; Variables: { app: AppContext } };

export const apiRoutes = new Hono<Ctx>();

/** Uniform rate-limit gate. Returns a Response when the caller must be stopped. */
async function gate(
  c: { env: Env; req: { raw: Request }; var: { app: AppContext } },
  rule: Parameters<typeof rateLimit>[1],
): Promise<Response | null> {
  const result = await rateLimit(c.env, rule, rateIdentity(c.req.raw, c.var.app.session.id));
  if (result.ok) return null;
  return new Response(JSON.stringify({ error: 'rate_limited', retry_in: result.resetIn }), {
    status: 429,
    headers: { 'content-type': 'application/json', ...rateLimitHeaders(result) },
  });
}

// ---------------------------------------------------------------- search (JSON)

apiRoutes.get('/api/search', async (c) => {
  const blocked = await gate(c, 'search');
  if (blocked) return blocked;

  const url = new URL(c.req.url);
  const query = (url.searchParams.get('q') ?? '').trim().slice(0, 300);
  if (!query) return c.json({ error: 'missing q' }, 400);

  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const format = url.searchParams.get('format');

  const { parseQueryCached } = await import('../search');
  const degradedHints: string[] = [];
  const baseParse = await parseQueryCached(c.env, query, (m) => degradedHints.push(m));
  const parse = applyUrlFilters(baseParse, url.searchParams);

  const response = await search(c.env, {
    query,
    parse,
    page,
    perPage: 24,
    session: c.var.app.session,
    degradedHints,
  });

  const { recordSearch } = await import('../search');
  c.executionCtx.waitUntil(recordSearch(c.env, response, c.var.app.session));

  // The infinite-scroll island wants ready-to-insert HTML, not JSON it has to
  // template — that keeps the client bundle small (ADR-1).
  if (format === 'html') {
    const queryHash = await sha256Hex(normaliseQuery(query));
    const saved = await savedSet(c.env, ownerKey(c.var.app.session), response.items.map((i) => i.id));
    return c.json({
      html: productGrid(response.items, {
        savedIds: saved,
        queryHash,
        startPos: (page - 1) * 24,
        now: Date.now(),
      }),
      has_more: response.has_more,
      total: response.total,
      page: response.page,
    });
  }

  return c.json({
    query: response.query,
    parse: response.parse,
    total: response.total,
    page: response.page,
    has_more: response.has_more,
    latency_ms: response.latency_ms,
    degraded: response.degraded,
    items: response.items.map((i) => ({
      id: i.id,
      title: i.title,
      brand: i.brand_name,
      price: i.price,
      mrp: i.mrp,
      currency: i.currency,
      url: `${c.env.SITE_URL}/p/${i.slug}-${i.id}`,
      image: i.image_url,
      availability: i.availability,
      match_reasons: i.match_reasons,
      promoted: i.promoted,
    })),
  });
});

async function savedSet(env: Env, owner: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  try {
    const res = await env.DB.prepare(
      `SELECT product_id FROM ${T.saves} WHERE owner_key = ? AND product_id IN (${inClause(ids.length)})`,
    )
      .bind(owner, ...ids)
      .all<{ product_id: string }>();
    return new Set((res.results ?? []).map((r) => r.product_id));
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------- suggest

apiRoutes.get('/api/suggest', async (c) => {
  const q = (c.req.query('q') ?? '').trim().toLowerCase().slice(0, 100);
  const session = c.var.app.session;

  const recent = (session.recent_queries ?? [])
    .filter((r) => !q || r.toLowerCase().includes(q))
    .slice(0, 4);

  let trending: string[] = [];
  let brands: { name: string; slug: string }[] = [];

  if (q.length >= 2) {
    const cacheKey = `suggest:${q}`;
    try {
      const cached = await c.env.CACHE.get(cacheKey, 'json');
      if (cached) {
        const hit = cached as { trending: string[]; brands: { name: string; slug: string }[] };
        return c.json({ recent, ...hit });
      }
    } catch {
      /* fall through */
    }

    const [t, b] = await Promise.all([
      c.env.DB.prepare(
        `SELECT query_raw, COUNT(*) AS n FROM ${T.searches}
         WHERE result_count > 0 AND query_raw LIKE ? AND ts > ?
         GROUP BY query_hash ORDER BY n DESC LIMIT 6`,
      )
        .bind(`%${q}%`, Date.now() - 30 * 86_400_000)
        .all<{ query_raw: string }>()
        .catch(() => ({ results: [] as { query_raw: string }[] })),
      c.env.DB.prepare(
        `SELECT name, slug FROM ${T.brands} WHERE status = 'active' AND lower(name) LIKE ? LIMIT 4`,
      )
        .bind(`${q}%`)
        .all<{ name: string; slug: string }>()
        .catch(() => ({ results: [] as { name: string; slug: string }[] })),
    ]);

    trending = (t.results ?? []).map((r) => r.query_raw);
    brands = b.results ?? [];

    try {
      await c.env.CACHE.put(cacheKey, JSON.stringify({ trending, brands }), {
        expirationTtl: 300,
      });
    } catch {
      /* non-fatal */
    }
  }

  return c.json({ recent, trending, brands }, 200, { 'cache-control': 'private, max-age=30' });
});

// ---------------------------------------------------------------- saves

const SaveBody = z.object({
  product_id: z.string().min(1).max(40),
  saved: z.boolean(),
});

apiRoutes.post('/api/save', async (c) => {
  const blocked = await gate(c, 'write');
  if (blocked) return blocked;

  const parsed = SaveBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'bad_request' }, 400);

  const { product_id, saved } = parsed.data;
  const owner = ownerKey(c.var.app.session);

  // Verify the product exists before writing — otherwise a hostile client can
  // fill the table with junk rows.
  const exists = await c.env.DB.prepare(`SELECT id FROM ${T.products} WHERE id = ?`)
    .bind(product_id)
    .first<{ id: string }>();
  if (!exists) return c.json({ error: 'not_found' }, 404);

  if (saved) {
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO ${T.saves} (id, owner_key, product_id, created_at) VALUES (?,?,?,?)`,
    )
      .bind(newId('sv'), owner, product_id, Date.now())
      .run();
  } else {
    await c.env.DB.prepare(`DELETE FROM ${T.saves} WHERE owner_key = ? AND product_id = ?`)
      .bind(owner, product_id)
      .run();
  }

  c.executionCtx.waitUntil(
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO ${T.events} (ts, type, session_id, user_id, product_id, meta)
       VALUES (?,?,?,?,?,'{}')`,
    )
      .bind(
        Date.now(),
        saved ? 'save' : 'unsave',
        c.var.app.session.id,
        c.var.app.session.user_id ?? null,
        product_id,
      )
      .run()
      .then(() => undefined)
      .catch(() => undefined),
  );

  return c.json({ ok: true, saved });
});

// ---------------------------------------------------------------- alerts

const AlertBody = z.object({
  product_id: z.string().min(1).max(40),
  kind: z.enum(['price_drop', 'back_in_stock']),
  email: z.string().email().max(200).optional(),
  target_rupees: z.number().positive().max(10_000_000).optional(),
});

apiRoutes.post('/api/alert', async (c) => {
  const blocked = await gate(c, 'write');
  if (blocked) return blocked;

  const parsed = AlertBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'bad_request' }, 400);
  const { product_id, kind, email, target_rupees } = parsed.data;

  const product = await c.env.DB.prepare(
    `SELECT id, price FROM ${T.products} WHERE id = ? AND status = 'active'`,
  )
    .bind(product_id)
    .first<{ id: string; price: number }>();
  if (!product) return c.json({ error: 'not_found' }, 404);

  await c.env.DB.prepare(
    `INSERT INTO ${T.alerts}
      (id, owner_key, product_id, kind, target_price, base_price, email, status, created_at)
     VALUES (?,?,?,?,?,?,?, 'armed', ?)
     ON CONFLICT(owner_key, product_id, kind) DO UPDATE SET
       status = 'armed',
       target_price = excluded.target_price,
       base_price = excluded.base_price,
       email = COALESCE(excluded.email, ${T.alerts}.email)`,
  )
    .bind(
      newId('al'),
      ownerKey(c.var.app.session),
      product_id,
      kind,
      target_rupees ? Math.round(target_rupees * 100) : null,
      product.price,
      email ?? null,
      Date.now(),
    )
    .run();

  return c.json({ ok: true, needs_email: !email && !c.var.app.session.user_id });
});

// ---------------------------------------------------------------- saved intents

const IntentBody = z.object({ query: z.string().min(3).max(300), email: z.string().email().optional() });

apiRoutes.post('/api/intent', async (c) => {
  const blocked = await gate(c, 'write');
  if (blocked) return blocked;
  const parsed = IntentBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'bad_request' }, 400);

  await c.env.DB.prepare(
    `INSERT INTO ${T.savedIntents} (id, owner_key, query_raw, parse, email, status, created_at)
     VALUES (?,?,?,'{}',?, 'active', ?)
     ON CONFLICT(owner_key, query_raw) DO UPDATE SET status = 'active'`,
  )
    .bind(
      newId('si'),
      ownerKey(c.var.app.session),
      parsed.data.query.trim(),
      parsed.data.email ?? null,
      Date.now(),
    )
    .run();

  return c.json({ ok: true });
});

// ---------------------------------------------------------------- report

const ReportBody = z.object({
  product_id: z.string().min(1).max(40),
  reason: z.enum(['dead_link', 'wrong_price', 'out_of_stock', 'spam', 'other']),
  note: z.string().max(500).optional(),
});

apiRoutes.post('/api/report', async (c) => {
  const blocked = await gate(c, 'report');
  if (blocked) return blocked;
  const parsed = ReportBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'bad_request' }, 400);

  await c.env.DB.prepare(
    `INSERT INTO ${T.reports} (id, product_id, reason, note, session_id, ts) VALUES (?,?,?,?,?,?)`,
  )
    .bind(
      newId('rp'),
      parsed.data.product_id,
      parsed.data.reason,
      parsed.data.note ?? null,
      c.var.app.session.id,
      Date.now(),
    )
    .run();

  // Three independent reports auto-demote the listing. Acting on user signal
  // immediately matters more than waiting for a human to triage (U22).
  c.executionCtx.waitUntil(
    c.env.DB.prepare(
      `UPDATE ${T.products} SET status = 'stale'
       WHERE id = ? AND (
         SELECT COUNT(DISTINCT session_id) FROM ${T.reports}
         WHERE product_id = ? AND resolved = 0
       ) >= 3`,
    )
      .bind(parsed.data.product_id, parsed.data.product_id)
      .run()
      .then(() => undefined)
      .catch(() => undefined),
  );

  return c.json({ ok: true });
});

// ---------------------------------------------------------------- image search

apiRoutes.post('/api/image-search', async (c) => {
  const blocked = await gate(c, 'image_search');
  if (blocked) return blocked;

  const form = await c.req.formData().catch(() => null);
  const file = form?.get('image');
  if (!(file instanceof File)) return c.json({ error: 'no_image' }, 400);

  const MAX_BYTES = 6 * 1024 * 1024;
  if (file.size > MAX_BYTES) return c.json({ error: 'too_large', max_bytes: MAX_BYTES }, 413);
  if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type)) {
    return c.json({ error: 'unsupported_type' }, 415);
  }

  const bytes = await file.arrayBuffer();
  const ai = await getAi(c.env);
  const parse = await ai.vision(bytes, file.type);

  if (!parse || !parse.semantic_text) {
    return c.json({ error: 'could_not_read_image' }, 422);
  }

  // Turn the vision result into a normal, shareable, indexable text query rather
  // than a stateful image session (U6).
  const derived = [
    ...parse.colors,
    ...parse.materials,
    ...parse.categories.map((x) => x.replace(/-/g, ' ')),
  ]
    .slice(0, 6)
    .join(' ')
    .trim();

  const query = derived || truncate(parse.semantic_text, 90);
  return c.json({ ok: true, query, redirect: `/search?q=${encodeURIComponent(query)}` });
});

// ---------------------------------------------------------------- stylist stream

const ChatBody = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(4000),
      }),
    )
    .min(1)
    .max(20),
});

/** Marker the model emits to request a live product grid. */
const SEARCH_MARKER = /\[\[SEARCH:\s*([^\]]{2,120})\]\]/;

apiRoutes.post('/api/stylist', async (c) => {
  const blocked = await gate(c, 'stylist');
  if (blocked) return blocked;

  const parsed = ChatBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'bad_request' }, 400);

  const env = c.env;
  const app = c.var.app;
  const messages: ChatMessage[] = [
    { role: 'system', content: STYLIST_SYSTEM_PROMPT },
    ...parsed.data.messages,
  ];

  const lastUser = [...parsed.data.messages].reverse().find((m) => m.role === 'user');
  if (lastUser && pushRecentQuery(app.session, lastUser.content.slice(0, 120))) {
    c.executionCtx.waitUntil(saveSession(env, app.session));
  }

  const encoder = new TextEncoder();
  const sse = (event: string, data: unknown) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const stream = new ReadableStream({
    async start(controller) {
      // Buffer only what could still be part of a marker, so partial "[[SEA…"
      // is never flushed to the user as visible text.
      let pending = '';
      let searchesRun = 0;

      const flushSafe = (force = false) => {
        if (force) {
          if (pending) controller.enqueue(sse('token', pending));
          pending = '';
          return;
        }
        // Hold back a tail that might begin a marker.
        const lastOpen = pending.lastIndexOf('[');
        const safeUpTo = lastOpen === -1 ? pending.length : lastOpen;
        if (safeUpTo > 0) {
          controller.enqueue(sse('token', pending.slice(0, safeUpTo)));
          pending = pending.slice(safeUpTo);
        }
      };

      try {
        const ai = await getAi(env, (m) => controller.enqueue(sse('degraded', m)));

        for await (const token of ai.chat(messages)) {
          pending += token;

          let match = SEARCH_MARKER.exec(pending);
          while (match) {
            // Emit text before the marker, then the resolved grid.
            const before = pending.slice(0, match.index);
            if (before) controller.enqueue(sse('token', before));
            pending = pending.slice(match.index + match[0].length);

            if (searchesRun < 3) {
              searchesRun++;
              const q = match[1].trim();
              try {
                const results = await search(env, {
                  query: q,
                  perPage: 4,
                  session: app.session,
                  noPromoted: true,
                });
                if (results.items.length) {
                  controller.enqueue(
                    sse('products', {
                      query: q,
                      html: `<p class="tiny" style="margin:var(--s4) 0 var(--s2)">${esc(q)} — <a href="/search?q=${encodeURIComponent(q)}">see all</a></p>${productGrid(results.items, { now: Date.now() })}`,
                    }),
                  );
                } else {
                  controller.enqueue(
                    sse('token', `\n\n_(nothing in stock for "${q}" right now)_\n\n`),
                  );
                }
              } catch {
                controller.enqueue(sse('degraded', 'stylist:search'));
              }
            }
            match = SEARCH_MARKER.exec(pending);
          }

          flushSafe();
        }

        flushSafe(true);
        controller.enqueue(sse('done', { ok: true }));
      } catch (err) {
        controller.enqueue(sse('token', "\n\nSomething broke on my side. Try a search instead."));
        controller.enqueue(sse('done', { ok: false }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
});

// ---------------------------------------------------------------- taste onboarding

const TasteBody = z.object({
  tags: z.record(z.string().max(40), z.number().min(-1).max(1)).refine(
    (obj) => Object.keys(obj).length <= 60,
    { message: 'too many tags' },
  ),
});

apiRoutes.post('/api/taste', async (c) => {
  const blocked = await gate(c, 'write');
  if (blocked) return blocked;
  const parsed = TasteBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'bad_request' }, 400);

  c.var.app.session.taste = { ...(c.var.app.session.taste ?? {}), ...parsed.data.tags };
  await saveSession(c.env, c.var.app.session);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- bounce-back

/**
 * Bounce-back beacon: fired when a user returns from a merchant within 10s,
 * which is our proxy for a bad hop-out (north-star metric, docs/01 §7).
 */
apiRoutes.post('/api/beacon/return', async (c) => {
  const body = await c.req.json().catch(() => null);
  const productId = typeof body?.product_id === 'string' ? body.product_id.slice(0, 40) : null;
  if (!productId) return c.body(null, 204);

  c.executionCtx.waitUntil(
    // `UPDATE ... ORDER BY ... LIMIT` requires a non-default SQLite compile
    // flag, so target the row via a subquery instead.
    c.env.DB.prepare(
      `UPDATE ${T.clicks} SET returned_at = ?
       WHERE id = (
         SELECT id FROM ${T.clicks}
         WHERE product_id = ? AND session_id = ? AND returned_at IS NULL AND ts > ?
         ORDER BY ts DESC LIMIT 1
       )`,
    )
      .bind(Date.now(), productId, c.var.app.session.id, Date.now() - 120_000)
      .run()
      .then(() => undefined)
      .catch(() => undefined),
  );

  return c.body(null, 204);
});
