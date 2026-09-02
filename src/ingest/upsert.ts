import type { Env } from '../types';
import { T } from '../lib/db';
import { chunk, newId } from '../lib/util';
import { ftsUpsertStatements } from '../search/lexical';
import { contentHash, type NormalisedItem, type RejectReason, normaliseItem } from './normalize';
import type { RawItem } from './normalize';

/**
 * Catalogue upsert.
 *
 * Two properties matter more than speed here:
 *   1. **Idempotence.** A cron tick can be retried at any point; re-running a
 *      sync must converge to the same state.
 *   2. **Write frugality.** D1's free tier allows 100k writes/day, and a daily
 *      full resync of 100k SKUs would blow that instantly. The content hash
 *      short-circuit means we only write rows that actually changed.
 */

export interface UpsertStats {
  rows_in: number;
  rows_upserted: number;
  rows_skipped: number;
  rows_rejected: number;
  reject_reasons: Record<string, number>;
  /** Ids needing (re-)embedding because their text changed. */
  needs_embedding: string[];
}

interface ExistingRow {
  id: string;
  external_id: string;
  content_hash: string | null;
  price: number;
  availability: string;
}

const DB_BATCH = 40;

export async function upsertCatalog(
  env: Env,
  brand: { id: string; name: string },
  rawItems: RawItem[],
  options: { markVanished?: boolean } = {},
): Promise<UpsertStats> {
  const stats: UpsertStats = {
    rows_in: rawItems.length,
    rows_upserted: 0,
    rows_skipped: 0,
    rows_rejected: 0,
    reject_reasons: {},
    needs_embedding: [],
  };

  // --- normalise -----------------------------------------------------------
  const normalised: NormalisedItem[] = [];
  const seenExternal = new Set<string>();

  for (const raw of rawItems) {
    const result = normaliseItem(raw);
    if (!result.ok) {
      stats.rows_rejected++;
      stats.reject_reasons[result.reason] = (stats.reject_reasons[result.reason] ?? 0) + 1;
      continue;
    }
    // Feeds routinely repeat the same product across pages.
    if (seenExternal.has(result.item.external_id)) {
      stats.rows_skipped++;
      continue;
    }
    seenExternal.add(result.item.external_id);
    normalised.push(result.item);
  }

  if (!normalised.length) return stats;

  // --- load existing state ------------------------------------------------
  const existing = new Map<string, ExistingRow>();
  try {
    const res = await env.DB.prepare(
      `SELECT id, external_id, content_hash, price, availability
       FROM ${T.products} WHERE brand_id = ?`,
    )
      .bind(brand.id)
      .all<ExistingRow>();
    for (const row of res.results ?? []) {
      if (row.external_id) existing.set(row.external_id, row);
    }
  } catch {
    // Treat as a cold catalogue; upserts are conflict-safe either way.
  }

  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  const touchedIds: string[] = [];

  for (const item of normalised) {
    const hash = await contentHash(item);
    const prior = existing.get(item.external_id);

    if (prior && prior.content_hash === hash) {
      // Unchanged: only refresh the liveness timestamp, which is what powers the
      // freshness ranking factor and the "checked Xh ago" trust signal.
      stats.rows_skipped++;
      touchedIds.push(prior.id);
      continue;
    }

    const id = prior?.id ?? newId('p');

    statements.push(
      env.DB.prepare(
        `INSERT INTO ${T.products} (
           id, brand_id, external_id, slug, title, description, category, subcategory,
           gender, price, mrp, currency, url, image_url, images, colors, sizes, materials,
           occasions, style_tags, attributes, availability, content_hash,
           last_verified_at, first_seen_at, updated_at, status
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?, 'INR', ?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'active')
         ON CONFLICT(brand_id, external_id) DO UPDATE SET
           slug = excluded.slug,
           title = excluded.title,
           description = excluded.description,
           category = excluded.category,
           subcategory = excluded.subcategory,
           gender = excluded.gender,
           price = excluded.price,
           mrp = excluded.mrp,
           url = excluded.url,
           image_url = excluded.image_url,
           images = excluded.images,
           colors = excluded.colors,
           sizes = excluded.sizes,
           materials = excluded.materials,
           occasions = excluded.occasions,
           style_tags = excluded.style_tags,
           attributes = excluded.attributes,
           availability = excluded.availability,
           content_hash = excluded.content_hash,
           last_verified_at = excluded.last_verified_at,
           updated_at = excluded.updated_at,
           status = CASE WHEN ${T.products}.status = 'hidden' THEN 'hidden' ELSE 'active' END`,
      ).bind(
        id,
        brand.id,
        item.external_id,
        item.slug,
        item.title,
        item.description,
        item.category,
        item.subcategory,
        item.gender,
        item.price,
        item.mrp,
        item.url,
        item.image_url,
        JSON.stringify(item.images),
        JSON.stringify(item.colors),
        JSON.stringify(item.sizes),
        JSON.stringify(item.materials),
        JSON.stringify(item.occasions),
        JSON.stringify(item.style_tags),
        JSON.stringify(item.attributes),
        item.availability,
        hash,
        now,
        // first_seen_at: bound unconditionally because D1 rejects `undefined`
        // binds. The ON CONFLICT clause above deliberately does not update it,
        // so an existing row keeps its original first-seen date.
        now,
        now,
      ),
    );

    // FTS is maintained explicitly rather than by trigger (see lexical.ts).
    statements.push(...ftsUpsertStatements(env.DB, { ...item, id }, brand.name));

    // Price history: append only on a real change, so the sparkline stays honest.
    if (!prior || prior.price !== item.price || prior.availability !== item.availability) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO ${T.priceHistory} (product_id, price, availability, ts) VALUES (?,?,?,?)`,
        ).bind(id, item.price, item.availability, now),
      );
    }

    stats.rows_upserted++;
    stats.needs_embedding.push(id);
    touchedIds.push(id);
  }

  // --- items that vanished from the feed -----------------------------------
  // Soft-delist rather than delete: a feed that briefly truncates must not wipe
  // a catalogue, and saved/alerted products must keep resolving.
  if (options.markVanished !== false) {
    const feedIds = new Set(normalised.map((i) => i.external_id));
    const vanished = [...existing.values()].filter(
      (row) => !feedIds.has(row.external_id) && row.availability !== 'out_of_stock',
    );
    for (const batch of chunk(vanished, DB_BATCH)) {
      statements.push(
        env.DB.prepare(
          `UPDATE ${T.products} SET availability = 'out_of_stock', updated_at = ?
           WHERE id IN (${batch.map(() => '?').join(',')})`,
        ).bind(now, ...batch.map((b) => b.id)),
      );
    }
  }

  // --- liveness refresh for unchanged rows ---------------------------------
  for (const batch of chunk(touchedIds, DB_BATCH)) {
    statements.push(
      env.DB.prepare(
        `UPDATE ${T.products} SET last_verified_at = ?
         WHERE id IN (${batch.map(() => '?').join(',')})`,
      ).bind(now, ...batch),
    );
  }

  statements.push(
    env.DB.prepare(
      `UPDATE ${T.brands} SET
         product_count = (SELECT COUNT(*) FROM ${T.products} WHERE brand_id = ? AND status = 'active'),
         updated_at = ?
       WHERE id = ?`,
    ).bind(brand.id, now, brand.id),
  );

  // D1 caps statements per batch; chunk to stay well inside it.
  for (const batch of chunk(statements, DB_BATCH)) {
    await env.DB.batch(batch);
  }

  return stats;
}

/** Reject reason → merchant-readable explanation for the feed dashboard. */
export const REJECT_EXPLANATIONS: Record<RejectReason, string> = {
  missing_title: 'No product title',
  missing_url: 'No product URL',
  bad_url: 'Product URL is not a valid https:// address',
  placeholder_url: 'Product URL uses an example, test, or local placeholder domain',
  missing_price: 'No price',
  implausible_price: 'Price outside ₹49–₹50,00,000 (usually a currency/unit error)',
  unmappable_category: 'Could not map to a known category — add a clearer product_type or tags',
  missing_image: 'No https image URL',
};
