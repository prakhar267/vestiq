import type { Env, ParsedQuery, SortKey } from '../types';
import { T } from '../lib/db';
import { ftsQuote, unique } from '../lib/util';

/**
 * Lexical recall over FTS5, plus the structured (no free text) browse path.
 *
 * Both arms return `{id, score}` only. Row hydration happens once, after
 * fusion, so we never pay to hydrate candidates that lose.
 */

export interface LexicalHit {
  id: string;
  score: number;
}

/** Stop-words that add noise to an OR-heavy FTS query. */
const STOP = new Set([
  'and', 'or', 'the', 'a', 'an', 'for', 'with', 'in', 'on', 'at', 'to', 'of',
  'is', 'are', 'be', 'my', 'me', 'i', 'it', 'that', 'this', 'some', 'any',
  'something', 'anything', 'looking', 'need', 'want', 'show', 'find', 'get',
  'like', 'but', 'not', 'no', 'under', 'over', 'above', 'below', 'size',
]);

/**
 * Build an FTS5 MATCH expression.
 *
 * Every token is quoted (see `ftsQuote`) so user input can never be interpreted
 * as an FTS operator — this is the injection boundary for the lexical arm.
 * Tokens are OR-ed for recall; precision comes from ranking and hard filters,
 * not from ANDing, which collapses recall on long conversational queries.
 */
export function buildFtsQuery(parse: ParsedQuery): string | null {
  const words = parse.semantic_text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2 && !STOP.has(w));

  const structured = [
    ...parse.categories.map((c) => c.replace(/-/g, ' ')),
    ...parse.colors,
    ...parse.materials,
    ...parse.occasions,
    ...parse.style_tags.map((s) => s.replace(/-/g, ' ')),
    ...parse.brands,
  ];

  // Cap total tokens: FTS5 cost grows with term count and long conversational
  // queries hit diminishing returns fast.
  const tokens = unique([...structured, ...words]).slice(0, 24);
  if (!tokens.length) return null;

  return tokens.map((t) => ftsQuote(t)).join(' OR ');
}

/**
 * Column weights for bm25: title dominates, brand matters, tags help,
 * description is mostly marketing copy and is weighted down accordingly.
 */
const BM25_WEIGHTS = '10.0, 6.0, 1.0, 4.0';

export async function lexicalSearch(
  env: Env,
  parse: ParsedQuery,
  limit = 200,
): Promise<LexicalHit[]> {
  const match = buildFtsQuery(parse);
  if (!match) return [];

  // NOTE: FTS5 auxiliary functions (bm25, highlight, snippet) must be given the
  // *real table name*, never an alias — `bm25(f)` raises "no such column: f".
  // The table is therefore referenced unaliased throughout this query.
  const sql = `
    SELECT ${T.productsFts}.product_id AS id,
           bm25(${T.productsFts}, ${BM25_WEIGHTS}) AS rank
    FROM ${T.productsFts}
    JOIN ${T.products} p ON p.id = ${T.productsFts}.product_id
    WHERE ${T.productsFts} MATCH ?1
      AND p.status = 'active'
      AND p.availability != 'out_of_stock'
    ORDER BY rank
    LIMIT ?2
  `;

  try {
    const res = await env.DB.prepare(sql).bind(match, limit).all<{ id: string; rank: number }>();
    // bm25() is negative, more negative = better. Flip so higher = better.
    return (res.results ?? []).map((r) => ({ id: r.id, score: -r.rank }));
  } catch (err) {
    // A malformed MATCH expression must not fail the search — the semantic and
    // structured arms can still carry the query. Logged rather than swallowed:
    // a silent catch here once hid a broken bm25() call that disabled the whole
    // lexical arm without any visible symptom.
    console.error(
      JSON.stringify({ level: 'error', msg: 'lexical search failed', error: String(err) }),
    );
    return [];
  }
}

export interface StructuredOptions {
  parse: ParsedQuery;
  sort?: SortKey;
  limit?: number;
  brandId?: string;
  /** Only products first seen after this timestamp (drops feed). */
  since?: number;
}

/**
 * Structured recall: pure SQL over normalised columns. Used for browse pages,
 * collections, brand pages, and as a safety net when both AI arms return
 * nothing (so a category-only query like "sarees" always works).
 */
export async function structuredSearch(
  env: Env,
  opts: StructuredOptions,
): Promise<LexicalHit[]> {
  const { parse, sort = 'relevance', limit = 200, brandId, since } = opts;
  const where: string[] = [`p.status = 'active'`, `p.availability != 'out_of_stock'`];
  const binds: unknown[] = [];

  if (brandId) {
    where.push('p.brand_id = ?');
    binds.push(brandId);
  }
  if (since) {
    where.push('p.first_seen_at >= ?');
    binds.push(since);
  }
  if (parse.categories.length) {
    where.push(`p.category IN (${parse.categories.map(() => '?').join(',')})`);
    binds.push(...parse.categories);
  }
  if (parse.gender) {
    // 'unisex' inventory is valid for any gendered query.
    where.push(`(p.gender = ? OR p.gender = 'unisex')`);
    binds.push(parse.gender);
  }
  if (parse.price_min !== undefined) {
    where.push('p.price >= ?');
    binds.push(parse.price_min);
  }
  if (parse.price_max !== undefined) {
    where.push('p.price <= ?');
    binds.push(parse.price_max);
  }

  // JSON array columns: LIKE on the serialised array is the only index-free
  // option in SQLite, but it is correct because values are canonical tokens
  // written by us, always quoted, so '"cotton"' cannot partially match.
  for (const color of parse.colors) {
    where.push('p.colors LIKE ?');
    binds.push(`%"${color}"%`);
  }
  for (const color of parse.exclude_colors) {
    where.push('p.colors NOT LIKE ?');
    binds.push(`%"${color}"%`);
  }
  for (const material of parse.materials) {
    where.push('p.materials LIKE ?');
    binds.push(`%"${material}"%`);
  }
  for (const occasion of parse.occasions) {
    where.push('p.occasions LIKE ?');
    binds.push(`%"${occasion}"%`);
  }
  if (parse.sizes.length) {
    where.push(`(${parse.sizes.map(() => 'p.sizes LIKE ?').join(' OR ')})`);
    binds.push(...parse.sizes.map((s) => `%"${s}"%`));
  }

  const orderBy: Record<SortKey, string> = {
    relevance: 'p.popularity DESC, p.first_seen_at DESC',
    price_asc: 'p.price ASC',
    price_desc: 'p.price DESC',
    newest: 'p.first_seen_at DESC',
    popular: 'p.popularity DESC',
  };

  const sql = `
    SELECT p.id AS id, p.popularity AS pop
    FROM ${T.products} p
    WHERE ${where.join(' AND ')}
    ORDER BY ${orderBy[sort] ?? orderBy.relevance}
    LIMIT ?
  `;
  binds.push(limit);

  try {
    const res = await env.DB.prepare(sql).bind(...binds).all<{ id: string; pop: number }>();
    const rows = res.results ?? [];
    // Positional score so this arm can join the RRF fusion on equal terms.
    return rows.map((r, i) => ({ id: r.id, score: rows.length - i }));
  } catch {
    return [];
  }
}

/** Replace a product's FTS row. Called on every upsert (see ingest/upsert.ts). */
export function ftsUpsertStatements(
  db: D1Database,
  product: {
    id: string;
    title: string;
    description?: string | null;
    category: string;
    colors: string[];
    materials: string[];
    occasions: string[];
    style_tags: string[];
    subcategory?: string | null;
  },
  brandName: string,
): D1PreparedStatement[] {
  const tags = unique([
    product.category.replace(/-/g, ' '),
    ...(product.subcategory ? [product.subcategory] : []),
    ...product.colors,
    ...product.materials,
    ...product.occasions,
    ...product.style_tags.map((s) => s.replace(/-/g, ' ')),
  ]).join(' ');

  return [
    db.prepare(`DELETE FROM ${T.productsFts} WHERE product_id = ?`).bind(product.id),
    db
      .prepare(
        `INSERT INTO ${T.productsFts} (product_id, title, brand_name, description, tags)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(product.id, product.title, brandName, product.description ?? '', tags),
  ];
}
