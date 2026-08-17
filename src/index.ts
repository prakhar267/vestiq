import { Hono } from 'hono';
import type { AppContext, Env } from './types';
import { T } from './lib/db';
import { isBotUA, newId } from './lib/util';
import { makeLogger } from './lib/log';
import { resolveSession, saveSession } from './lib/session';
import { securityHeaders } from './ui/layout';
import { layout } from './ui/layout';
import { pageRoutes } from './routes/pages';
import { apiRoutes } from './routes/api';
import { adminRoutes } from './routes/admin';
import { merchantRoutes } from './routes/merchant';
import { seoRoutes } from './routes/seo';
import { goRoutes } from './routes/go';
import { handleScheduled } from './jobs';

type Ctx = {
  Bindings: Env;
  Variables: { app: AppContext; session: AppContext['session'] };
};

const app = new Hono<Ctx>();

/**
 * Request context: id, session, bot detection, CSP nonce.
 *
 * The session is resolved for every request including crawlers, because saves
 * and alerts work anonymously (ADR-8). KV writes are deferred to waitUntil so
 * session bookkeeping never sits on the response path.
 */
app.use('*', async (c, next) => {
  const requestId = c.req.header('cf-ray') ?? newId('req');
  const log = makeLogger(requestId, c.env.LOG_LEVEL);
  const started = Date.now();

  const { session, setCookie, dirty } = await resolveSession(c.req.raw, c.env);

  const appCtx: AppContext = {
    session,
    requestId,
    isBot: isBotUA(c.req.header('user-agent') ?? ''),
    // 128 bits of nonce, per request, for the strict CSP.
    nonce: newId('', 22),
  };
  c.set('app', appCtx);
  c.set('session', session);

  await next();

  if (dirty) c.executionCtx.waitUntil(saveSession(c.env, session));
  if (setCookie) c.header('set-cookie', setCookie, { append: true });

  for (const [k, v] of Object.entries(securityHeaders(appCtx.nonce))) {
    c.header(k, v);
  }
  c.header('x-request-id', requestId);

  // One structured line per request. Query text is intentionally not logged.
  log.info('request', {
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    status: c.res.status,
    ms: Date.now() - started,
    bot: appCtx.isBot,
  });
});

/**
 * Health check with per-component status (docs/03 §8). Returns 503 when a
 * hard dependency is down so uptime monitoring is meaningful rather than
 * just "the Worker responded".
 */
app.get('/health', async (c) => {
  const checks: Record<string, { ok: boolean; ms?: number; note?: string }> = {};

  const timed = async (name: string, fn: () => Promise<unknown>, hard: boolean) => {
    const t0 = Date.now();
    try {
      await fn();
      checks[name] = { ok: true, ms: Date.now() - t0 };
    } catch (err) {
      checks[name] = { ok: false, ms: Date.now() - t0, note: String(err).slice(0, 120) };
      if (hard) hardFailure = true;
    }
  };

  let hardFailure = false;

  await Promise.all([
    timed('d1', () => c.env.DB.prepare(`SELECT 1 AS ok FROM ${T.brands} LIMIT 1`).first(), true),
    timed('kv_cache', () => c.env.CACHE.get('health:probe'), true),
    timed('kv_vectors', () => c.env.VECTORS.get('vec:active'), false),
  ]);

  checks.ai = {
    ok: Boolean(c.env.AI) || Boolean(c.env.GEMINI_API_KEY),
    note: c.env.GEMINI_API_KEY
      ? 'gemini + workers-ai'
      : c.env.AI
        ? 'workers-ai only'
        : 'heuristic only (degraded)',
  };
  checks.admin_configured = { ok: Boolean(c.env.ADMIN_TOKEN) };

  return c.json(
    {
      status: hardFailure ? 'unhealthy' : 'healthy',
      version: '1.0.0',
      site: c.env.SITE_NAME,
      time: new Date().toISOString(),
      checks,
    },
    hardFailure ? 503 : 200,
    { 'cache-control': 'no-store' },
  );
});

// Routes are mounted most-specific-first so /api and /admin can't be shadowed
// by the page router's catch-alls.
app.route('/', seoRoutes);
app.route('/', apiRoutes);
app.route('/', adminRoutes);
app.route('/', merchantRoutes);
app.route('/', goRoutes);
app.route('/', pageRoutes);

app.notFound((c) => {
  const appCtx = c.var.app;
  // Static asset misses and API misses shouldn't render a full HTML page.
  if (c.req.path.startsWith('/api/')) return c.json({ error: 'not_found' }, 404);

  return c.html(
    layout(
      {
        env: c.env,
        title: `Not found — ${c.env.SITE_NAME}`,
        description: 'That page does not exist.',
        path: c.req.path,
        nonce: appCtx?.nonce ?? '',
        noindex: true,
        showHeaderSearch: true,
      },
      `<div class="wrap-narrow"><section class="section">
        <h1>That's not here.</h1>
        <p class="muted">The piece may have sold out and been delisted, or the link is wrong.</p>
        <p><a class="btn btn-primary" href="/">Start a new search</a></p>
      </section></div>`,
    ),
    404,
  );
});

app.onError((err, c) => {
  const appCtx = c.var.app;
  const log = makeLogger(appCtx?.requestId ?? 'unknown', c.env.LOG_LEVEL);
  log.error('unhandled error', err, { path: new URL(c.req.url).pathname });

  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: 'internal_error', request_id: appCtx?.requestId }, 500);
  }

  // A designed error state, never a stack trace — this page is user-facing.
  return c.html(
    layout(
      {
        env: c.env,
        title: `Something broke — ${c.env.SITE_NAME}`,
        description: 'An unexpected error occurred.',
        path: c.req.path,
        nonce: appCtx?.nonce ?? '',
        noindex: true,
      },
      `<div class="wrap-narrow"><section class="section">
        <h1>Something broke on our side.</h1>
        <p class="muted">We've logged it. Try again, or start a fresh search.</p>
        <p><a class="btn btn-primary" href="/">Back to search</a></p>
        <p class="tiny">Reference: ${appCtx?.requestId ?? 'unknown'}</p>
      </section></div>`,
    ),
    500,
  );
});

export default {
  fetch: app.fetch,

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleScheduled(event, env));
  },
} satisfies ExportedHandler<Env>;
