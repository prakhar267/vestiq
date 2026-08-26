import type { Availability, Brand, Env, Gender, Product } from '../types';
import { safeJson } from './util';

/**
 * Table name registry.
 *
 * ADR-9: Vestiq shares a D1 database with another project, so every table is
 * namespaced. Changing PREFIX to '' after moving to a dedicated database is the
 * entire migration — nothing else in the codebase hardcodes a table name.
 */
export const PREFIX = 'vestiq_';

const t = (name: string) => `${PREFIX}${name}`;

export const T = {
  migrations: t('migrations'),
  brands: t('brands'),
  products: t('products'),
  productsFts: t('products_fts'),
  priceHistory: t('price_history'),
  collections: t('collections'),
  searches: t('searches'),
  events: t('events'),
  clicks: t('clicks'),
  reports: t('reports'),
  users: t('users'),
  saves: t('saves'),
  alerts: t('alerts'),
  savedIntents: t('saved_intents'),
  merchants: t('merchants'),
  feedRuns: t('feed_runs'),
  promotions: t('promotions'),
  flags: t('flags'),
  jobs: t('jobs'),
  auditLog: t('audit_log'),
} as const;

/** Columns needed to build a ResultItem, with the brand join. Kept in one place
 *  so the select list can't drift from the row mappers below. */
export const PRODUCT_COLUMNS = `
  p.id, p.brand_id, p.external_id, p.slug, p.title, p.description, p.category,
  p.subcategory, p.gender, p.price, p.mrp, p.currency, p.url, p.image_url,
  p.images, p.colors, p.sizes, p.materials, p.occasions, p.style_tags,
  p.attributes, p.availability, p.rating, p.review_count, p.popularity,
  p.last_verified_at, p.first_seen_at, p.updated_at, p.status,
  b.name AS brand_name, b.slug AS brand_slug, b.trust_score AS brand_trust,
  b.ship_days AS brand_ship_days
`;

export function rowToProduct(r: Record<string, unknown>): Product {
  return {
    id: String(r.id),
    brand_id: String(r.brand_id),
    external_id: (r.external_id as string) ?? null,
    slug: String(r.slug),
    title: String(r.title),
    description: (r.description as string) ?? null,
    category: String(r.category),
    subcategory: (r.subcategory as string) ?? null,
    gender: String(r.gender) as Gender,
    price: Number(r.price),
    mrp: r.mrp === null || r.mrp === undefined ? null : Number(r.mrp),
    currency: String(r.currency ?? 'INR'),
    url: String(r.url),
    image_url: (r.image_url as string) ?? null,
    images: safeJson<string[]>(r.images as string, []),
    colors: safeJson<string[]>(r.colors as string, []),
    sizes: safeJson<string[]>(r.sizes as string, []),
    materials: safeJson<string[]>(r.materials as string, []),
    occasions: safeJson<string[]>(r.occasions as string, []),
    style_tags: safeJson<string[]>(r.style_tags as string, []),
    attributes: safeJson<Record<string, unknown>>(r.attributes as string, {}),
    availability: String(r.availability ?? 'in_stock') as Availability,
    rating: r.rating === null || r.rating === undefined ? null : Number(r.rating),
    review_count: Number(r.review_count ?? 0),
    popularity: Number(r.popularity ?? 0),
    last_verified_at:
      r.last_verified_at === null || r.last_verified_at === undefined
        ? null
        : Number(r.last_verified_at),
    first_seen_at: Number(r.first_seen_at ?? 0),
    updated_at: Number(r.updated_at ?? 0),
    status: String(r.status ?? 'active'),
  };
}

export function rowToBrand(r: Record<string, unknown>): Brand {
  return {
    id: String(r.id),
    slug: String(r.slug),
    name: String(r.name),
    domain: (r.domain as string) ?? null,
    logo_url: (r.logo_url as string) ?? null,
    description: (r.description as string) ?? null,
    city: (r.city as string) ?? null,
    country: String(r.country ?? 'IN'),
    price_tier: String(r.price_tier ?? 'mid'),
    style_tags: safeJson<string[]>(r.style_tags as string, []),
    trust_score: Number(r.trust_score ?? 50),
    ship_days: r.ship_days === null || r.ship_days === undefined ? null : Number(r.ship_days),
    return_days:
      r.return_days === null || r.return_days === undefined ? null : Number(r.return_days),
    has_return_policy: Number(r.has_return_policy ?? 0),
    affiliate_network: (r.affiliate_network as string) ?? null,
    affiliate_rate_bp: Number(r.affiliate_rate_bp ?? 0),
    affiliate_tmpl: (r.affiliate_tmpl as string) ?? null,
    product_count: Number(r.product_count ?? 0),
    status: String(r.status ?? 'active'),
    created_at: Number(r.created_at ?? 0),
    updated_at: Number(r.updated_at ?? 0),
  };
}

/**
 * Build a parameterised `IN (?,?,...)` clause. Never interpolate ids directly —
 * this is the only sanctioned way to do a multi-id lookup.
 */
export function inClause(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

/** Feature flags / kill switches, cached in KV for 60s. */
export async function getFlag<T>(env: Env, key: string, fallback: T): Promise<T> {
  const cacheKey = `flag:${key}`;
  const cached = await env.CACHE.get(cacheKey);
  if (cached !== null) return safeJson<T>(cached, fallback);
  try {
    const row = await env.DB.prepare(`SELECT value FROM ${T.flags} WHERE key = ?`)
      .bind(key)
      .first<{ value: string }>();
    const value = row ? safeJson<T>(row.value, fallback) : fallback;
    await env.CACHE.put(cacheKey, JSON.stringify(value), { expirationTtl: 60 });
    return value;
  } catch {
    return fallback;
  }
}

export async function setFlag(env: Env, key: string, value: unknown): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO ${T.flags} (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(key, JSON.stringify(value), Date.now())
    .run();
  await env.CACHE.delete(`flag:${key}`);
}

export async function audit(
  env: Env,
  actor: string,
  action: string,
  target?: string,
  meta: Record<string, unknown> = {},
  ip?: string,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO ${T.auditLog} (ts, actor, action, target, meta, ip) VALUES (?,?,?,?,?,?)`,
    )
      .bind(Date.now(), actor, action, target ?? null, JSON.stringify(meta), ip ?? null)
      .run();
  } catch {
    // Auditing must never break the request it is auditing.
  }
}
