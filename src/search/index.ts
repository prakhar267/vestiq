import type {
  Env,
  ParsedQuery,
  Product,
  ResultItem,
  SearchResponse,
  SessionData,
  SortKey,
} from '../types';
import { PRODUCT_COLUMNS, T, inClause, rowToProduct } from '../lib/db';
import { newId, normaliseQuery, safeJson, sha256Hex } from '../lib/util';
import type { Logger } from '../lib/log';
import { getAi } from '../ai/provider';
import { heuristicParse } from '../ai/heuristic';
import { lexicalSearch, structuredSearch } from './lexical';
import { computeFacets } from './facets';
import { quantise, vectorSearch } from './vector';
import {
  applyFilters,
  buildRelaxations,
  fuse,
  matchReasons,
  scoreItem,
  toArms,
} from './rank';

/**
 * Recall pool size. Bounded because every candidate costs a hydrated D1 row.
 * 400 gives ~16 pages of depth, which is far beyond where users actually go.
 */
export const CANDIDATE_POOL = 400;
const PARSE_CACHE_TTL = 7 * 24 * 60 * 60; // 7 days (ADR-6)
/**
 * Bump this whenever parser behaviour or validation changes.
 *
 * A 7-day cache means a bad parse outlives the bug that produced it: degenerate
 * vocabulary-echo parses stayed live after the fix shipped. The version prefix
 * is the invalidation mechanism.
 *   v1 → v2: added looksDegenerate() rejection and styling-problem preservation.
 */
const PARSE_CACHE_VERSION = 'v2';

export interface SearchOptions {
  query: string;
  /** Pre-computed parse (image search, saved intents, refinement chips). */
  parse?: ParsedQuery;
  page?: number;
  perPage?: number;
  sort?: SortKey;
  session?: SessionData;
  brandId?: string;
  since?: number;
  logger?: Logger;
  includeScoreParts?: boolean;
  /**
   * Degradation signals collected before search() was called — notably from
   * query parsing, which callers do separately so they can apply URL filters on
   * top. Without this, a parser fallback was invisible in `response.degraded`.
   */
  degradedHints?: string[];
}

/**
 * Parse a query, using the KV cache when possible (ADR-6: the parse is stable,
 * the results are not, so only the parse is cached long-term).
 */
export async function parseQueryCached(
  env: Env,
  query: string,
  onDegrade: (m: string) => void,
): Promise<ParsedQuery> {
  const normalised = normaliseQuery(query);
  if (!normalised) return heuristicParse(query);

  const hash = await sha256Hex(normalised);
  const key = `parse:${PARSE_CACHE_VERSION}:${hash}`;

  try {
    const cached = await env.CACHE.get(key, 'json');
    if (cached) {
      const parse = cached as ParsedQuery;
      // Validate on read as well as on write. Belt-and-braces: a cache entry can
      // outlive the code that wrote it, so trusting stored parses unconditionally
      // means one bad deploy poisons relevance for a week.
      const { looksDegenerate } = await import('../ai/provider');
      if (
        !looksDegenerate({
          categories: parse.categories ?? [],
          occasions: parse.occasions ?? [],
          style_tags: parse.style_tags ?? [],
          colors: parse.colors ?? [],
          materials: parse.materials ?? [],
        })
      ) {
        return parse;
      }
      onDegrade('parse:cache-rejected');
      await env.CACHE.delete(key).catch(() => undefined);
    }
  } catch {
    // Cache read failures are non-fatal.
  }

  const ai = await getAi(env, onDegrade);
  const parse = await ai.parseQuery(query);

  // Never cache a heuristic-only parse: it is the degraded path, and caching it
  // for a week would make an inference blip permanently poison relevance.
  if (parse.provider && parse.provider !== 'heuristic') {
    try {
      await env.CACHE.put(key, JSON.stringify(parse), { expirationTtl: PARSE_CACHE_TTL });
    } catch {
      // Non-fatal.
    }
  }

  return parse;
}

/** Embed the query for the semantic arm, but only if the live index speaks the
 *  same embedding language (ADR-5: vectors are not portable across providers). */
async function embedForActiveIndex(
  env: Env,
  text: string,
  onDegrade: (m: string) => void,
): Promise<Int8Array | null> {
  const { getActiveVersion } = await import('./vector');
  const activeVersion = await getActiveVersion(env);
  if (activeVersion === null) return null;

  const ai = await getAi(env, onDegrade);
  const provider = ai.embedProvider;
  if (!provider?.embedModel) return null;
  if (provider.embedModel.version !== activeVersion) {
    // The index was built by a different provider. Using this provider's vectors
    // against it would return confident nonsense, so skip the semantic arm.
    onDegrade('embed:version-mismatch');
    return null;
  }

  const out = await ai.embed([text]);
  if (!out || !out.vectors[0]) return null;
  return quantise(out.vectors[0]);
}

/** Hydrate candidate ids into full rows with their brand fields, preserving nothing
 *  about order (ranking re-sorts anyway). */
async function hydrate(
  env: Env,
  ids: string[],
): Promise<Map<string, Product & { brand_name: string; brand_slug: string; brand_trust: number; brand_ship_days: number | null }>> {
  const out = new Map<
    string,
    Product & {
      brand_name: string;
      brand_slug: string;
      brand_trust: number;
      brand_ship_days: number | null;
    }
  >();
  if (!ids.length) return out;

  // D1 caps bound parameters per statement; chunk defensively.
  const CHUNK = 100;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const sql = `
      SELECT ${PRODUCT_COLUMNS}
      FROM ${T.products} p
      JOIN ${T.brands} b ON b.id = p.brand_id
      WHERE p.id IN (${inClause(slice.length)})
        AND p.status = 'active'
        AND b.status = 'active'
    `;
    const res = await env.DB.prepare(sql)
      .bind(...slice)
      .all<Record<string, unknown>>();
    for (const row of res.results ?? []) {
      out.set(String(row.id), {
        ...rowToProduct(row),
        brand_name: String(row.brand_name),
        brand_slug: String(row.brand_slug),
        brand_trust: Number(row.brand_trust ?? 50),
        brand_ship_days:
          row.brand_ship_days === null || row.brand_ship_days === undefined
            ? null
            : Number(row.brand_ship_days),
      });
    }
  }
  return out;
}

export async function search(env: Env, opts: SearchOptions): Promise<SearchResponse> {
  const started = Date.now();
  const degraded: string[] = [];
  const onDegrade = (m: string) => {
    if (!degraded.includes(m)) degraded.push(m);
  };
  for (const hint of opts.degradedHints ?? []) onDegrade(hint);

  // A parse that fell all the way back to the heuristic is itself a degradation,
  // regardless of which callback observed it.
  if (opts.parse?.provider === 'heuristic') onDegrade('parse:heuristic');

  const page = Math.max(1, opts.page ?? 1);
  const perPage = Math.min(48, Math.max(1, opts.perPage ?? 24));
  const sort: SortKey = opts.sort ?? 'relevance';

  const parse = opts.parse ?? (await parseQueryCached(env, opts.query, onDegrade));

  // --- recall: three arms, in parallel -------------------------------------
  const [lexical, queryVec, structured] = await Promise.all([
    lexicalSearch(env, parse, CANDIDATE_POOL).catch(() => {
      onDegrade('lexical');
      return [];
    }),
    embedForActiveIndex(env, parse.semantic_text || opts.query, onDegrade).catch(() => {
      onDegrade('embed');
      return null;
    }),
    structuredSearch(env, {
      parse,
      sort: sort === 'relevance' ? 'popular' : sort,
      limit: CANDIDATE_POOL,
      brandId: opts.brandId,
      since: opts.since,
    }).catch(() => {
      onDegrade('structured');
      return [];
    }),
  ]);

  let vector = null;
  if (queryVec) {
    const vs = await vectorSearch(env, queryVec, CANDIDATE_POOL).catch(() => {
      onDegrade('vector');
      return null;
    });
    vector = vs?.hits ?? null;
    if (!vs) onDegrade('vector:no-index');
  }

  // --- fuse ----------------------------------------------------------------
  const arms = toArms(lexical, vector, structured, parse);
  let fused = fuse(arms).slice(0, CANDIDATE_POOL);

  // Brand-scoped views (brand page, collection) must never leak other brands in
  // through the lexical or semantic arms.
  const rows = await hydrate(
    env,
    fused.map((f) => f.id),
  );

  let candidates = fused
    .map((f) => ({ fused: f, row: rows.get(f.id) }))
    .filter((x): x is { fused: typeof fused[number]; row: NonNullable<ReturnType<typeof rows.get>> } =>
      Boolean(x.row),
    );

  if (opts.brandId) candidates = candidates.filter((c) => c.row.brand_id === opts.brandId);

  // --- hard filters --------------------------------------------------------
  const filtered = applyFilters(
    candidates.map((c) => c.row),
    parse,
  );
  const keptIds = new Set(filtered.kept.map((p) => p.id));
  const surviving = candidates.filter((c) => keptIds.has(c.row.id));

  // --- score ---------------------------------------------------------------
  const now = Date.now();
  let scored: ResultItem[] = surviving.map(({ fused: f, row }) => {
    const { score, parts } = scoreItem({
      fused: f,
      product: row,
      brandTrust: row.brand_trust,
      parse,
      now,
      session: opts.session,
    });
    return {
      ...row,
      score,
      match_reasons: matchReasons(row, parse),
      ...(opts.includeScoreParts ? { score_parts: parts } : {}),
    };
  });

  // Explicit sorts override relevance entirely — a user asking for cheapest
  // first means it, and silently blending relevance in would look broken.
  if (sort === 'price_asc') scored.sort((a, b) => a.price - b.price);
  else if (sort === 'price_desc') scored.sort((a, b) => b.price - a.price);
  else if (sort === 'newest') scored.sort((a, b) => b.first_seen_at - a.first_seen_at);
  else if (sort === 'popular') scored.sort((a, b) => b.popularity - a.popularity);
  else scored.sort((a, b) => b.score - a.score);

  const total = scored.length;
  const facets = computeFacets(scored);

  // --- page slice ----------------------------------------------------------
  const offset = (page - 1) * perPage;
  const items = scored.slice(offset, offset + perPage);

  const relaxations = total === 0 ? buildRelaxations(parse, opts.query, filtered.binding) : [];

  return {
    query: opts.query,
    parse,
    items,
    facets,
    total,
    capped: total >= CANDIDATE_POOL,
    page,
    per_page: perPage,
    has_more: offset + items.length < total,
    latency_ms: Date.now() - started,
    relaxations,
    degraded,
  };
}

/**
 * Record the search for analytics. Fire-and-forget via waitUntil — the user must
 * never wait on our own instrumentation.
 */
export async function recordSearch(
  env: Env,
  response: SearchResponse,
  session?: SessionData,
): Promise<void> {
  try {
    const hash = await sha256Hex(normaliseQuery(response.query));
    await env.DB.prepare(
      `INSERT INTO ${T.searches}
       (id, query_hash, query_raw, parse, intent, result_count, latency_ms, provider, session_id, user_id, ts)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(
        newId('s'),
        hash,
        response.query.slice(0, 500),
        JSON.stringify(response.parse),
        response.parse.intent,
        response.total,
        response.latency_ms,
        response.parse.provider ?? 'unknown',
        session?.id ?? null,
        session?.user_id ?? null,
        Date.now(),
      )
      .run();
  } catch {
    // Analytics must never break search.
  }
}

/** Trending queries for the home page, from the last 7 days of real searches. */
export async function trendingQueries(env: Env, limit = 10): Promise<string[]> {
  const cacheKey = `trending:queries:${limit}`;
  try {
    const cached = await env.CACHE.get(cacheKey, 'json');
    if (cached) return cached as string[];
  } catch {
    /* fall through */
  }

  try {
    const res = await env.DB.prepare(
      `SELECT query_raw, COUNT(*) AS n
       FROM ${T.searches}
       WHERE ts > ? AND result_count > 0 AND length(query_raw) BETWEEN 8 AND 60
       GROUP BY query_hash
       ORDER BY n DESC
       LIMIT ?`,
    )
      .bind(Date.now() - 7 * 86_400_000, limit)
      .all<{ query_raw: string }>();
    const out = (res.results ?? []).map((r) => r.query_raw);
    await env.CACHE.put(cacheKey, JSON.stringify(out), { expirationTtl: 900 });
    return out;
  } catch {
    return [];
  }
}

export { safeJson };
