import type { Env } from '../types';
import { T } from './db';

export const SCHEDULER_HEARTBEAT_KEY = 'cron:last:tick';
const SCHEDULER_FRESH_MS = 60 * 60 * 1000;

export function schedulerHeartbeatTimestamp(raw: string | null): number {
  if (!raw) return 0;
  const direct = Number(raw);
  if (Number.isFinite(direct)) return direct;
  try {
    const parsed = JSON.parse(raw) as { ts?: unknown };
    return typeof parsed.ts === 'number' && Number.isFinite(parsed.ts) ? parsed.ts : 0;
  } catch {
    return 0;
  }
}

/** Verify that a real scheduler has reached the Worker recently, not merely
 * that a driver name exists in configuration. */
export async function schedulerFreshness(
  env: Env,
  now = Date.now(),
): Promise<{ ok: boolean; note: string }> {
  if (env.SCHEDULER_DRIVER !== 'github-actions' && env.SCHEDULER_DRIVER !== 'cloudflare-cron') {
    return { ok: false, note: 'no dependable scheduler declared' };
  }
  try {
    const ts = schedulerHeartbeatTimestamp(await env.CACHE.get(SCHEDULER_HEARTBEAT_KEY));
    if (!ts) return { ok: false, note: 'no scheduler heartbeat recorded yet' };
    const ageMinutes = Math.max(0, Math.floor((now - ts) / 60_000));
    return {
      ok: now - ts <= SCHEDULER_FRESH_MS,
      note: `last successful tick ${ageMinutes}m ago`,
    };
  } catch {
    return { ok: false, note: 'scheduler heartbeat unavailable' };
  }
}

export interface CatalogueReadiness {
  active_brands: number;
  active_products: number;
  placeholder_brands: number;
  placeholder_products: number;
}

const PLACEHOLDER_BRAND_SQL = `(
  lower(COALESCE(b.domain, '')) = 'example.in'
  OR lower(COALESCE(b.domain, '')) LIKE '%.example.in'
  OR lower(COALESCE(b.domain, '')) IN ('example.com', 'example.org', 'example.net', 'localhost', '127.0.0.1', '::1')
  OR lower(COALESCE(b.domain, '')) LIKE '%.example.com'
  OR lower(COALESCE(b.domain, '')) LIKE '%.example.org'
  OR lower(COALESCE(b.domain, '')) LIKE '%.example.net'
  OR lower(COALESCE(b.domain, '')) LIKE '%.localhost'
  OR lower(COALESCE(b.domain, '')) LIKE '%.example'
  OR lower(COALESCE(b.domain, '')) LIKE '%.test'
  OR lower(COALESCE(b.domain, '')) LIKE '%.invalid'
)`;

const PLACEHOLDER_PRODUCT_SQL = `(
  ${PLACEHOLDER_BRAND_SQL}
  OR lower(p.url) LIKE 'http%://example.in/%'
  OR lower(p.url) LIKE 'http%://%.example.in/%'
  OR lower(p.url) LIKE 'http%://example.com/%'
  OR lower(p.url) LIKE 'http%://%.example.com/%'
  OR lower(p.url) LIKE 'http%://example.org/%'
  OR lower(p.url) LIKE 'http%://%.example.org/%'
  OR lower(p.url) LIKE 'http%://example.net/%'
  OR lower(p.url) LIKE 'http%://%.example.net/%'
  OR lower(p.url) LIKE 'http%://example/%'
  OR lower(p.url) LIKE 'http%://%.example/%'
  OR lower(p.url) LIKE 'http%://test/%'
  OR lower(p.url) LIKE 'http%://%.test/%'
  OR lower(p.url) LIKE 'http%://invalid/%'
  OR lower(p.url) LIKE 'http%://%.invalid/%'
  OR lower(p.url) LIKE 'http%://localhost/%'
  OR lower(p.url) LIKE 'http%://127.0.0.1/%'
)`;

/** One bounded query used by health, readiness, and deployment smoke checks. */
export async function catalogueReadiness(env: Env): Promise<CatalogueReadiness> {
  const row = await env.DB.prepare(
    `SELECT
      (SELECT COUNT(*) FROM ${T.brands} WHERE status = 'active') AS active_brands,
      (SELECT COUNT(*) FROM ${T.products} WHERE status = 'active') AS active_products,
      (SELECT COUNT(*) FROM ${T.brands} b WHERE b.status = 'active' AND ${PLACEHOLDER_BRAND_SQL}) AS placeholder_brands,
      (SELECT COUNT(*) FROM ${T.products} p JOIN ${T.brands} b ON b.id = p.brand_id
       WHERE p.status = 'active' AND b.status = 'active' AND ${PLACEHOLDER_PRODUCT_SQL}) AS placeholder_products`,
  ).first<Record<string, number>>();

  return {
    active_brands: Number(row?.active_brands ?? 0),
    active_products: Number(row?.active_products ?? 0),
    placeholder_brands: Number(row?.placeholder_brands ?? 0),
    placeholder_products: Number(row?.placeholder_products ?? 0),
  };
}

export function configurationReadiness(env: Env): Record<string, { ok: boolean; note: string }> {
  let customDomain = false;
  let configuredHost = 'invalid SITE_URL';
  try {
    configuredHost = new URL(env.SITE_URL).hostname;
    customDomain = !configuredHost.endsWith('.workers.dev');
  } catch {
    customDomain = false;
  }

  const schedulerDriver = env.SCHEDULER_DRIVER;
  const schedulerOk =
    schedulerDriver === 'github-actions' || schedulerDriver === 'cloudflare-cron';

  return {
    email_delivery: {
      ok: Boolean(env.RESEND_API_KEY),
      note: env.RESEND_API_KEY ? 'Resend configured' : 'RESEND_API_KEY missing',
    },
    scheduler: {
      ok: schedulerOk,
      note: schedulerOk
        ? schedulerDriver === 'github-actions'
          ? env.SCHEDULER_PIGGYBACK === '1'
            ? 'GitHub Actions every 15 minutes + traffic fallback'
            : 'GitHub Actions every 15 minutes'
          : 'Cloudflare cron every 15 minutes'
        : env.SCHEDULER_PIGGYBACK === '1'
          ? 'traffic-driven only; enable a dependable scheduler before relying on alerts'
          : 'no dependable scheduler declared',
    },
    custom_domain: {
      ok: customDomain,
      note: customDomain ? configuredHost : 'still using workers.dev',
    },
    multimodal_ai: {
      ok: Boolean(env.GEMINI_API_KEY),
      note: env.GEMINI_API_KEY ? 'Gemini configured' : 'Workers AI fallback only',
    },
  };
}
