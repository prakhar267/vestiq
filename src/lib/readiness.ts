import type { Env } from '../types';
import { T } from './db';

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

  return {
    email_delivery: {
      ok: Boolean(env.RESEND_API_KEY),
      note: env.RESEND_API_KEY ? 'Resend configured' : 'RESEND_API_KEY missing',
    },
    scheduler: {
      ok: env.SCHEDULER_PIGGYBACK !== '1',
      note:
        env.SCHEDULER_PIGGYBACK === '1'
          ? 'traffic-driven; enable a native cron before relying on alerts'
          : 'native or external driver expected',
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
