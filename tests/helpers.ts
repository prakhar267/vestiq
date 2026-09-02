import { env as rawEnv } from 'cloudflare:test';
import initSql from '../migrations/0001_init.sql?raw';
import launchSql from '../migrations/0003_launch_integrity_and_retention.sql?raw';
import productExpansionSql from '../migrations/0005_profiles_trips_and_attribution.sql?raw';
import type { Env } from '../src/types';

/**
 * Typed test bindings.
 *
 * `env` from 'cloudflare:test' is typed against the ambient `Cloudflare.Env`,
 * which is empty unless types are generated from wrangler.toml. Casting once
 * here gives every test full type safety without fighting ambient declarations.
 */
export const env = rawEnv as unknown as Env;

/**
 * Split a migration file into executable statements.
 *
 * Naive approaches break in two ways that both occur in our schema:
 *   - `split(';')` splits on semicolons inside string literals;
 *   - stripping only whole-line `--` comments leaves trailing comments, and one
 *     of ours legitimately contains a semicolon (`-- paise; null = any drop`),
 *     which would terminate a statement mid-column-list.
 *
 * So this is a single pass tracking both string and line-comment state.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inString = false;
  let inComment = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];

    if (inComment) {
      if (ch === '\n') {
        inComment = false;
        current += ch;
      }
      continue;
    }

    if (!inString && ch === '-' && sql[i + 1] === '-') {
      inComment = true;
      i++;
      continue;
    }

    if (ch === "'") {
      // '' inside a string is an escaped quote, not a terminator.
      if (inString && sql[i + 1] === "'") {
        current += "''";
        i++;
        continue;
      }
      inString = !inString;
      current += ch;
      continue;
    }

    if (ch === ';' && !inString) {
      if (current.trim()) statements.push(current.trim());
      current = '';
      continue;
    }

    current += ch;
  }

  if (current.trim()) statements.push(current.trim());
  return statements;
}

let migrated = false;

export async function migrate(): Promise<void> {
  if (migrated) return;
  for (const statement of splitStatements(`${initSql}\n${launchSql}\n${productExpansionSql}`)) {
    await env.DB.prepare(statement).run();
  }
  migrated = true;
}

export async function resetData(): Promise<void> {
  const tables = [
    'vestiq_products_fts',
    'vestiq_price_history',
    'vestiq_saves',
    'vestiq_alerts',
    'vestiq_saved_intents',
    'vestiq_brand_follows',
    'vestiq_auth_tokens',
    'vestiq_look_items',
    'vestiq_looks',
    'vestiq_trip_looks',
    'vestiq_trips',
    'vestiq_profiles',
    'vestiq_clicks',
    'vestiq_events',
    'vestiq_searches',
    'vestiq_reports',
    'vestiq_promotions',
    'vestiq_feed_runs',
    'vestiq_merchants',
    'vestiq_collections',
    'vestiq_products',
    'vestiq_brands',
    'vestiq_jobs',
  ];
  for (const table of tables) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
}

export interface SeedProductOptions {
  id?: string;
  title?: string;
  category?: string;
  price?: number;
  mrp?: number | null;
  colors?: string[];
  materials?: string[];
  occasions?: string[];
  styleTags?: string[];
  sizes?: string[];
  availability?: string;
  gender?: string;
  lastVerifiedAt?: number | null;
  popularity?: number;
  brandId?: string;
  status?: string;
}

let counter = 0;

export async function seedBrand(
  overrides: { id?: string; name?: string; slug?: string; trust?: number; status?: string } = {},
): Promise<string> {
  counter++;
  const id = overrides.id ?? `b_test${counter}`;
  const name = overrides.name ?? `Test Brand ${counter}`;
  const slug = overrides.slug ?? `test-brand-${counter}`;
  await env.DB.prepare(
    `INSERT OR REPLACE INTO vestiq_brands
      (id, slug, name, domain, city, country, price_tier, style_tags, trust_score,
       ship_days, return_days, has_return_policy, affiliate_rate_bp, product_count,
       status, created_at, updated_at)
     VALUES (?,?,?,?,?, 'IN', 'mid', '[]', ?, 4, 14, 1, 0, 0, ?, ?, ?)`,
  )
    .bind(
      id,
      slug,
      name,
      `${slug}.fashion`,
      'Bengaluru',
      overrides.trust ?? 75,
      overrides.status ?? 'active',
      Date.now() - 200 * 86_400_000,
      Date.now(),
    )
    .run();
  return id;
}

export async function seedProduct(
  brandId: string,
  opts: SeedProductOptions = {},
): Promise<string> {
  counter++;
  const id = opts.id ?? `p_test${counter}`;
  const title = opts.title ?? `Test Cotton Kurta ${counter}`;
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const brand = await env.DB.prepare(`SELECT name, slug FROM vestiq_brands WHERE id = ?`)
    .bind(brandId)
    .first<{ name: string; slug: string }>();

  const colors = opts.colors ?? ['blue'];
  const materials = opts.materials ?? ['cotton'];
  const occasions = opts.occasions ?? ['casual'];
  const styleTags = opts.styleTags ?? ['minimal'];
  const imageUrl =
    'https://images.unsplash.com/photo-1529139574466-a303027c1d8b?auto=format&fit=crop&w=900&q=80';

  await env.DB.prepare(
    `INSERT OR REPLACE INTO vestiq_products
      (id, brand_id, external_id, slug, title, description, category, subcategory, gender,
       price, mrp, currency, url, image_url, images, colors, sizes, materials, occasions,
       style_tags, attributes, availability, rating, review_count, popularity, content_hash,
       embed_version, last_verified_at, first_seen_at, updated_at, status)
     VALUES (?,?,?,?,?,?,?,NULL,?,?,?, 'INR', ?,?,?,?,?,?,?,?, '{}', ?, 4.2, 10, ?, ?, 0, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      brandId,
      `ext-${id}`,
      slug,
      title,
      `${title} description with cotton fabric.`,
      opts.category ?? 'kurtas',
      opts.gender ?? 'women',
      opts.price ?? 199_900,
      opts.mrp === undefined ? 299_900 : opts.mrp,
      `https://${brand?.slug ?? 'brand'}.fashion/products/${slug}`,
      imageUrl,
      JSON.stringify([imageUrl]),
      JSON.stringify(colors),
      JSON.stringify(opts.sizes ?? ['s', 'm', 'l']),
      JSON.stringify(materials),
      JSON.stringify(occasions),
      JSON.stringify(styleTags),
      opts.availability ?? 'in_stock',
      opts.popularity ?? 1,
      `hash-${id}`,
      opts.lastVerifiedAt === undefined ? Date.now() : opts.lastVerifiedAt,
      Date.now() - 10 * 86_400_000,
      Date.now(),
      opts.status ?? 'active',
    )
    .run();

  // Mirror what ingestion does, so lexical search works in tests.
  await env.DB.prepare(
    `INSERT INTO vestiq_products_fts (product_id, title, brand_name, description, tags)
     VALUES (?,?,?,?,?)`,
  )
    .bind(
      id,
      title,
      brand?.name ?? 'Test Brand',
      `${title} description with cotton fabric.`,
      [
        (opts.category ?? 'kurtas').replace(/-/g, ' '),
        ...colors,
        ...materials,
        ...occasions,
        ...styleTags,
      ].join(' '),
    )
    .run();

  await env.DB.prepare(
    `UPDATE vestiq_brands SET product_count = product_count + 1 WHERE id = ?`,
  )
    .bind(brandId)
    .run();

  return id;
}
