import { Hono } from 'hono';
import type { AppContext, Brand, Env, ParsedQuery, ResultItem, SortKey } from '../types';
import { PRODUCT_COLUMNS, T, inClause, rowToBrand, rowToProduct } from '../lib/db';
import { esc, formatINR, newId, normaliseQuery, safeJson, sha256Hex, timeAgo, truncate } from '../lib/util';
import { mergeOwner, ownerKey, saveSession } from '../lib/session';
import { sendEmail } from '../lib/email';
import { hasFitProfile, loadShopperProfile, persistFitProfile, persistTasteProfile, sanitiseFitProfile } from '../lib/profile';
import { rateIdentity, rateLimit } from '../lib/ratelimit';
import {
  ALL_CATEGORIES,
  ALL_COLORS,
  ALL_MATERIALS,
  ALL_OCCASIONS,
  ALL_STYLES,
  COMPLEMENTS,
  label,
} from '../ai/lexicon';
import { heuristicParse } from '../ai/heuristic';
import { search, trendingQueries, type SearchHardFacet } from '../search';
import { priceBandRange } from '../search/facets';
import { ICONS, layout, searchBarShell } from '../ui/layout';
import {
  brandCard,
  chipLinks,
  emptyState,
  filterRail,
  imageUrl,
  matchReasonChips,
  pagination,
  parseChips,
  priceBlock,
  productGrid,
  refineRail,
  sectionHead,
  sortSelect,
  sparkline,
  trustPill,
} from '../ui/components';

type Ctx = { Bindings: Env; Variables: { app: AppContext } };

export const pageRoutes = new Hono<Ctx>();

const SORTS: SortKey[] = ['relevance', 'price_asc', 'price_desc', 'newest', 'popular'];
const MAX_FACET_VALUES = 8;
const MAX_PRICE_RUPEES = 10_000_000;
const SIZE_VALUE = /^(?:xxs|xs|s|m|l|xl|xxl|3xl|4xl|5xl|free|\d{1,2}(?:\.\d)?)$/;
const BRAND_VALUE = /^(?=.{1,80}$)[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const BRAND_DROP_VALUE = /^[\p{L}\p{N}&.' _-]{1,80}$/u;

const FACET_VALUES: Record<string, Set<string>> = {
  category: new Set(ALL_CATEGORIES),
  color: new Set(ALL_COLORS),
  material: new Set(ALL_MATERIALS),
  occasion: new Set(ALL_OCCASIONS),
  style: new Set(ALL_STYLES),
};

function appendValidatedMany(
  out: URLSearchParams,
  raw: URLSearchParams,
  key: string,
  valid: (value: string) => boolean,
): void {
  const seen = new Set<string>();
  for (const input of raw.getAll(key)) {
    const value = input.trim().toLowerCase();
    if (!value || seen.has(value) || !valid(value)) continue;
    out.append(key, value);
    seen.add(value);
    if (seen.size >= MAX_FACET_VALUES) break;
  }
}

function validatedRupees(value: string | null): number | null {
  if (!value || !/^\d{1,8}$/.test(value)) return null;
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount > 0 && amount <= MAX_PRICE_RUPEES
    ? amount
    : null;
}

function validDrop(value: string): boolean {
  if (value === 'price_max' || value === 'price_min' || value === 'gender') return true;
  const split = value.indexOf(':');
  if (split < 1) return false;
  const kind = value.slice(0, split);
  const token = value.slice(split + 1).trim().toLowerCase();
  if (!token) return false;
  if (kind === 'xcolor') return FACET_VALUES.color.has(token);
  if (kind === 'size') return SIZE_VALUE.test(token);
  if (kind === 'brand' || kind === 'like') return BRAND_DROP_VALUE.test(value.slice(split + 1));
  const param = kind === 'category' || kind === 'color' || kind === 'material' || kind === 'occasion' || kind === 'style'
    ? kind
    : null;
  return Boolean(param && FACET_VALUES[param].has(token));
}

/**
 * Canonical, bounded search state shared by the HTML and JSON routes.
 * Unknown values never reach parsing/filtering and repeated facets cannot grow
 * request work without bound.
 */
export function validatedSearchParams(
  raw: URLSearchParams,
  query = (raw.get('q') ?? '').trim().slice(0, 300),
): URLSearchParams {
  const out = new URLSearchParams();
  if (query) out.set('q', query);

  for (const [key, allowed] of Object.entries(FACET_VALUES)) {
    appendValidatedMany(out, raw, key, (value) => allowed.has(value));
  }
  appendValidatedMany(out, raw, 'size', (value) => SIZE_VALUE.test(value));
  appendValidatedMany(out, raw, 'brand', (value) => BRAND_VALUE.test(value));

  const bands = raw
    .getAll('price_band')
    .map((value) => value.trim().toLowerCase())
    .find((value) => priceBandRange(value));
  if (bands) out.set('price_band', bands);

  let min = validatedRupees(raw.get('min'));
  const max = validatedRupees(raw.get('max'));
  if (min !== null && max !== null && min > max) min = null;
  if (min !== null) out.set('min', String(min));
  if (max !== null) out.set('max', String(max));

  const sort = raw.get('sort') as SortKey | null;
  if (sort && SORTS.includes(sort)) out.set('sort', sort);

  const pageRaw = raw.get('page');
  if (pageRaw && /^\d{1,4}$/.test(pageRaw)) {
    out.set('page', String(Math.min(1000, Math.max(1, Number(pageRaw)))));
  }
  if (raw.get('debug') === '1') out.set('debug', '1');
  if (raw.get('filters') === '1') out.set('filters', '1');

  const drops = new Set<string>();
  for (const input of raw.getAll('drop')) {
    const value = input.trim();
    if (!validDrop(value) || drops.has(value)) continue;
    out.append('drop', value);
    drops.add(value);
    if (drops.size >= 20) break;
  }

  return out;
}

export function validatedSort(params: URLSearchParams): SortKey {
  const value = params.get('sort') as SortKey | null;
  return value && SORTS.includes(value) ? value : 'relevance';
}

/** Attribute facets are soft in prose but hard after an explicit filter action. */
export function explicitHardFacets(params: URLSearchParams): SearchHardFacet[] {
  const filterForm = params.get('filters') === '1';
  const out: SearchHardFacet[] = [];
  if (filterForm || params.has('color')) out.push('colors');
  if (filterForm || params.has('material')) out.push('materials');
  if (filterForm || params.has('occasion')) out.push('occasions');
  if (filterForm || params.has('style')) out.push('style_tags');
  return out;
}

/** Which products this owner has already saved, so hearts render filled. */
async function savedIds(env: Env, owner: string, ids: string[]): Promise<Set<string>> {
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

/**
 * Facet selections from the URL override the AI's parse.
 *
 * The user's explicit click always wins over the model's inference — otherwise
 * unchecking a filter appears to do nothing, which reads as a broken product.
 */
export function applyUrlFilters(parse: ParsedQuery, params: URLSearchParams): ParsedQuery {
  const clean = validatedSearchParams(params, params.get('q') ?? '');
  const filterForm = clean.get('filters') === '1';
  const out: ParsedQuery = {
    ...parse,
    categories: [...parse.categories],
    colors: [...parse.colors],
    exclude_colors: [...parse.exclude_colors],
    materials: [...parse.materials],
    occasions: [...parse.occasions],
    style_tags: [...parse.style_tags],
    brands: [...parse.brands],
    like_brands: [...parse.like_brands],
    sizes: [...parse.sizes],
    exclude_terms: [...parse.exclude_terms],
  };

  const categories = clean.getAll('category');
  if (categories.length || filterForm) out.categories = categories;

  const colors = clean.getAll('color');
  if (colors.length || filterForm) out.colors = colors;

  const materials = clean.getAll('material');
  if (materials.length || filterForm) out.materials = materials;

  const occasions = clean.getAll('occasion');
  if (occasions.length || filterForm) out.occasions = occasions;

  const styles = clean.getAll('style');
  if (styles.length || filterForm) out.style_tags = styles;

  const sizes = clean.getAll('size');
  if (sizes.length || filterForm) out.sizes = sizes;

  // The public facet carries a brand slug. Hydrated candidates carry both that
  // slug and the immutable brand id, so hard filtering never relies on a label.
  const brands = clean.getAll('brand');
  if (brands.length || filterForm) out.brands = brands;

  const band = clean.get('price_band');
  if (band) {
    const range = priceBandRange(band);
    if (range) {
      out.price_min = range.min > 0 ? range.min : undefined;
      // Facet bands are half-open; ParsedQuery price bounds are inclusive.
      out.price_max = range.max === null ? undefined : range.max - 1;
    }
  }

  const minRupees = validatedRupees(clean.get('min'));
  if (minRupees !== null) out.price_min = minRupees * 100;
  const maxRupees = validatedRupees(clean.get('max'));
  if (maxRupees !== null) out.price_max = maxRupees * 100;

  // Chip removal (data-drop) arrives as ?drop=color:black
  for (const drop of clean.getAll('drop')) {
    const split = drop.indexOf(':');
    const kind = split === -1 ? drop : drop.slice(0, split);
    const value = split === -1 ? '' : drop.slice(split + 1);
    switch (kind) {
      case 'category':
        out.categories = out.categories.filter((v) => v !== value);
        break;
      case 'color':
        out.colors = out.colors.filter((v) => v !== value);
        break;
      case 'material':
        out.materials = out.materials.filter((v) => v !== value);
        break;
      case 'occasion':
        out.occasions = out.occasions.filter((v) => v !== value);
        break;
      case 'style':
        out.style_tags = out.style_tags.filter((v) => v !== value);
        break;
      case 'xcolor':
        out.exclude_colors = out.exclude_colors.filter((v) => v !== value);
        break;
      case 'size':
        out.sizes = out.sizes.filter((v) => v !== value);
        break;
      case 'like':
        out.like_brands = out.like_brands.filter((v) => v !== value);
        break;
      case 'brand':
        out.brands = out.brands.filter(
          (v) => v.toLowerCase() !== value.toLowerCase(),
        );
        break;
      case 'price_max':
        out.price_max = undefined;
        break;
      case 'price_min':
        out.price_min = undefined;
        break;
      case 'gender':
        out.gender = undefined;
        break;
    }
  }

  return out;
}

// ============================================================ home

pageRoutes.get('/', async (c) => {
  const { app } = c.var;
  const env = c.env;

  // Home is the same for everyone, so it is fully cacheable and cheap.
  const [trending, freshDrops, newBrands, picks] = await Promise.all([
    trendingQueries(env, 8),
    latestProducts(env, 10),
    latestBrands(env, 6),
    popularProducts(env, 10),
  ]);

  // Never advertise a dead search. Examples are derived from the live,
  // in-stock catalogue rather than from aspirational categories we may not yet
  // carry. As more merchants arrive, this surface updates automatically.
  const exampleQueries = inventorySearchExamples([...freshDrops, ...picks], 6);

  const jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: env.SITE_NAME,
      url: env.SITE_URL,
      description: env.SITE_TAGLINE,
      potentialAction: {
        '@type': 'SearchAction',
        target: {
          '@type': 'EntryPoint',
          urlTemplate: `${env.SITE_URL}/search?q={search_term_string}`,
        },
        'query-input': 'required name=search_term_string',
      },
    },
  ];

  const body = `
<section class="hero"><div class="wrap">
  <p class="hero-kicker">AI stylist · live Indian fashion inventory</p>
  <h1>Fashion the internet hid from you.</h1>
  <p class="tagline">${esc(env.SITE_TAGLINE)} Search independent brands by mood, occasion, budget — or a screenshot.</p>
  ${searchBarShell('hero')}
  ${exampleQueries.length ? `<div class="examples">
    <ul class="chips">
      ${exampleQueries
        .map(
          (q) =>
            `<li><a class="chip" href="/search?q=${encodeURIComponent(q)}">${esc(q)}</a></li>`,
        )
        .join('')}
    </ul>
  </div>` : ''}
</div></section>

<section class="journey-strip"><div class="wrap journey-grid">
  <a class="journey-card" href="/look-builder" data-journey>
    <span class="journey-icon" aria-hidden="true">01</span>
    <span><strong>Build one complete look</strong><small>Coordinated pieces inside one total budget</small></span>
    <span class="journey-action" aria-hidden="true">Open <span>→</span></span>
  </a>
  <a class="journey-card" href="/trip-planner" data-journey>
    <span class="journey-icon" aria-hidden="true">02</span>
    <span><strong>Plan a trip wardrobe</strong><small>Day-by-day looks without budget surprises</small></span>
    <span class="journey-action" aria-hidden="true">Open <span>→</span></span>
  </a>
  <a class="journey-card" href="/profile" data-journey>
    <span class="journey-icon" aria-hidden="true">03</span>
    <span><strong>Remember my fit</strong><small>Lift pieces available in your usual sizes</small></span>
    <span class="journey-action" aria-hidden="true">Open <span>→</span></span>
  </a>
  <a class="journey-card" href="/visual-search" data-journey>
    <span class="journey-icon" aria-hidden="true">04</span>
    <span><strong>Search from a photo</strong><small>Turn a screenshot into a live-catalogue query</small></span>
    <span class="journey-action" aria-hidden="true">Open <span>→</span></span>
  </a>
</div></section>

${
  trending.length
    ? `<section class="section"><div class="wrap">
    ${sectionHead('Trending searches')}
    ${chipLinks(trending.map((q) => ({ label: q, href: `/search?q=${encodeURIComponent(q)}` })))}
  </div></section>`
    : ''
}

${
  freshDrops.length
    ? `<section class="section"><div class="wrap">
    ${sectionHead('Fresh drops', '/drops')}
    ${productGrid(freshDrops, { now: Date.now() })}
  </div></section>`
    : ''
}

${
  newBrands.length
    ? `<section class="section"><div class="wrap">
    ${sectionHead('New brands', '/brands')}
    <div class="grid">${newBrands.map(brandCard).join('')}</div>
  </div></section>`
    : ''
}

${
  picks.length
    ? `<section class="section"><div class="wrap">
    ${sectionHead('Vestiq picks')}
    ${productGrid(picks, { now: Date.now() })}
  </div></section>`
    : ''
}

<section class="section"><div class="wrap-narrow" style="text-align:center">
  <h2>Run a fashion label?</h2>
  <p class="muted" style="margin:var(--s3) auto var(--s5)">
    Get in front of shoppers already asking for exactly what you make. Paste your
    store URL and we'll do the rest — no integration work.
  </p>
  <a class="btn btn-primary" href="/merchant/signup">List your brand ${ICONS.arrow}</a>
</div></section>`;

  return c.html(
    layout(
      {
        env,
        title: `${env.SITE_NAME} — ${env.SITE_TAGLINE}`,
        description: `Describe what you want in plain words and discover independent fashion brands by mood, occasion, budget, or a photo.`,
        path: '/',
        nonce: app.nonce,
        jsonLd,
        showMobileDock: false,
      },
      body,
    ),
  );
});

// ============================================================ visual search entry

pageRoutes.get('/visual-search', (c) =>
  c.html(
    layout(
      {
        env: c.env,
        title: `Visual search — ${c.env.SITE_NAME}`,
        description: 'Upload a fashion photo or screenshot and find visually similar pieces in the live catalogue.',
        path: '/visual-search',
        nonce: c.var.app.nonce,
        noindex: true,
        showHeaderSearch: true,
        activeNav: 'search',
      },
      `<div class="wrap-narrow"><section class="section visual-search-panel">
        <p class="eyebrow">Visual search</p><h1>Start with the image in your head.</h1>
        <p class="muted">Upload a screenshot or photo. Vestiq reads the visible colour, fabric and silhouette, then turns it into an editable search across real stock.</p>
        <div class="upload-stage"><div class="upload-mark" aria-hidden="true">＋</div><h2>Choose a fashion image</h2>
          <p class="tiny">JPEG, PNG or WebP · up to 6 MB · images are processed, not retained</p>
          <button class="btn btn-primary" type="button" data-image-search hidden>Choose image</button>
          <noscript><p class="notice">Visual search needs JavaScript. You can still <a href="/search">search with words</a>.</p></noscript>
        </div>
        <div class="notice"><strong>You stay in control.</strong> The generated description opens as a normal text search, so you can change or remove every inferred detail.</div>
      </section></div>`,
    ),
  ),
);

// ============================================================ search

pageRoutes.get('/search', async (c) => {
  const { app } = c.var;
  const env = c.env;
  const url = new URL(c.req.url);
  const query = (url.searchParams.get('q') ?? '').trim().slice(0, 300);
  const params = validatedSearchParams(url.searchParams, query);

  if (!query) {
    return c.html(
      layout(
        {
          env,
          title: `Search — ${env.SITE_NAME}`,
          description: 'Search independent fashion brands by mood, occasion or budget.',
          path: '/search',
          nonce: app.nonce,
          showHeaderSearch: false,
          showMobileDock: true,
          noindex: true,
        },
        `<section class="hero"><div class="wrap">
          <h1>What are you looking for?</h1>
          <p class="tagline">Describe it however you think about it.</p>
          ${searchBarShell('hero')}
        </div></section>`,
      ),
    );
  }

  const page = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1);
  const sort = validatedSort(params);

  // Parse, then let explicit URL filters override the model.
  const { parseQueryCached } = await import('../search');
  const degraded: string[] = [];
  const baseParse = await parseQueryCached(env, query, (m) => degraded.push(m));
  const parse = applyUrlFilters(baseParse, params);

  const response = await search(env, {
    query,
    parse,
    page,
    perPage: 24,
    sort,
    session: app.session,
    includeScoreParts: params.get('debug') === '1',
    degradedHints: degraded,
    filterMode: 'natural-language',
    hardFacets: explicitHardFacets(params),
  });

  const { recordSearch } = await import('../search');
  c.executionCtx.waitUntil(recordSearch(env, response, app.session));

  const queryHash = await sha256Hex(normaliseQuery(query));
  const saved = await savedIds(
    env,
    ownerKey(app.session),
    response.items.map((i) => i.id),
  );

  const searchState = new URLSearchParams(params);
  searchState.delete('page');
  const resultPath = `/search?${searchState.toString()}`;
  const canonicalPath = `/search?q=${encodeURIComponent(query)}${page > 1 ? `&page=${page}` : ''}`;

  const jsonLd =
    response.items.length > 0
      ? [
          {
            '@context': 'https://schema.org',
            '@type': 'ItemList',
            name: `${query} — ${env.SITE_NAME}`,
            // Count what is actually in the list, not the overall (possibly capped) total.
              numberOfItems: Math.min(response.items.length, 24),
            itemListElement: response.items.slice(0, 24).map((item, i) => ({
              '@type': 'ListItem',
              position: (page - 1) * 24 + i + 1,
              url: `${env.SITE_URL}/p/${item.slug}-${item.id}`,
              name: item.title,
            })),
          },
        ]
      : [];

  const pageHref = (target: number) => {
    const next = new URLSearchParams(searchState);
    if (target > 1) next.set('page', String(target));
    return `${esc(env.SITE_URL)}/search?${esc(next.toString())}`;
  };
  const relLinks = [
    page > 1 ? `<link rel="prev" href="${pageHref(page - 1)}">` : '',
    response.has_more ? `<link rel="next" href="${pageHref(page + 1)}">` : '',
  ].join('');

  const body = `
${parseChips(response.parse, query)}
<div class="wrap">
  <div class="results-head">
    <div>
      <h1 style="font-size:var(--t-h2)">${esc(truncate(query, 80))}</h1>
      <p class="tiny" aria-live="polite" style="margin:var(--s1) 0 0">
        ${response.total.toLocaleString('en-IN')}${response.capped ? '+' : ''} ${response.total === 1 ? 'piece' : 'pieces'}
        ${response.degraded.length ? ' · <span class="badge warn">smart search degraded</span>' : ''}
      </p>
      <p style="margin-top:var(--s3)">
        <a class="btn btn-sm" href="/save-search?q=${encodeURIComponent(query)}">Save this search</a>
        <a class="btn btn-sm" href="/look-builder?q=${encodeURIComponent(query)}">Build a complete look</a>
      </p>
      ${hasFitProfile(app.session) ? '<p class="tiny fit-active">✓ Ranked with your saved fit profile</p>' : '<p class="tiny"><a href="/profile">Add your sizes</a> for fit-aware ranking.</p>'}
    </div>
    ${sortSelect(sort, query, params)}
  </div>
</div>

${
  response.total === 0
    ? emptyState(response)
    : `<div class="wrap">
      <div class="layout-with-rail">
        ${filterRail(response.facets, query, params, response.filter_parse)}
        <div>
          ${refineRail(response.parse, query)}
          <div id="results" data-query="${esc(query)}" data-page="${page}" data-total="${response.total}">
            ${productGrid(response.items, {
              savedIds: saved,
              queryHash,
              startPos: (page - 1) * 24,
              now: Date.now(),
            })}
          </div>
          ${pagination(page, response.has_more, resultPath)}
        </div>
      </div>
    </div>`
}`;

  return c.html(
    layout(
      {
        env,
        title: `${truncate(query, 60)} — ${env.SITE_NAME}`,
        description: `${response.total}${response.capped ? '+' : ''} pieces matching "${truncate(query, 90)}" across independent fashion brands. ${env.SITE_TAGLINE}`,
        path: canonicalPath,
        nonce: app.nonce,
        jsonLd,
        head: relLinks,
        showHeaderSearch: true,
        showMobileDock: true,
        activeNav: 'search',
        // Thin result pages are an indexation liability (docs/01 §8).
        noindex: response.total < 6,
      },
      body,
    ),
  );
});

// ============================================================ product detail

pageRoutes.get('/p/:handle', async (c) => {
  const { app } = c.var;
  const env = c.env;
  const handle = c.req.param('handle');
  // Slugs contain hyphens and ids contain an underscore prefix, so the id is
  // everything after the final hyphen.
  const id = handle.slice(handle.lastIndexOf('-') + 1);
  if (!id) return c.notFound();

  const row = await env.DB.prepare(
    `SELECT ${PRODUCT_COLUMNS}, b.description AS brand_description, b.domain AS brand_domain,
            b.return_days AS brand_return_days, b.city AS brand_city,
            b.affiliate_tmpl AS brand_affiliate_tmpl
     FROM ${T.products} p JOIN ${T.brands} b ON b.id = p.brand_id
     WHERE p.id = ? AND p.status = 'active' AND b.status = 'active'`,
  )
    .bind(id)
    .first<Record<string, unknown>>();

  if (!row) return c.notFound();

  const product = rowToProduct(row);
  const item: ResultItem = {
    ...product,
    brand_name: String(row.brand_name),
    brand_slug: String(row.brand_slug),
    brand_trust: Number(row.brand_trust ?? 50),
    brand_ship_days:
      row.brand_ship_days === null || row.brand_ship_days === undefined
        ? null
        : Number(row.brand_ship_days),
    score: 0,
    match_reasons: [],
  };

  // Canonical URL uses the current slug; redirect if the handle drifted, so we
  // never serve one product on two indexable URLs.
  const canonicalHandle = `${product.slug}-${product.id}`;
  if (handle !== canonicalHandle) return c.redirect(`/p/${canonicalHandle}`, 301);

  const [similar, priceHistory, saved, armedAlerts] = await Promise.all([
    similarProducts(env, product, 10),
    priceHistoryFor(env, product.id),
    savedIds(env, ownerKey(app.session), [product.id]),
    env.DB.prepare(
      `SELECT kind FROM ${T.alerts} WHERE owner_key = ? AND product_id = ? AND status = 'armed'`,
    )
      .bind(ownerKey(app.session), product.id)
      .all<{ kind: string }>(),
  ]);

  const images = product.images.length ? product.images : product.image_url ? [product.image_url] : [];
  const off = product.mrp && product.mrp > product.price;
  const inStock = product.availability !== 'out_of_stock';
  const alertKind = inStock ? 'price_drop' : 'back_in_stock';
  const alertArmed = (armedAlerts.results ?? []).some((alert) => alert.kind === alertKind);

  const jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: product.title,
      description: product.description ?? undefined,
      image: images.slice(0, 5),
      sku: product.id,
      brand: { '@type': 'Brand', name: item.brand_name },
      ...(product.colors.length ? { color: product.colors.map(label).join(', ') } : {}),
      ...(product.materials.length ? { material: product.materials.map(label).join(', ') } : {}),
      ...(product.rating
        ? {
            aggregateRating: {
              '@type': 'AggregateRating',
              ratingValue: product.rating,
              reviewCount: Math.max(1, product.review_count),
            },
          }
        : {}),
      offers: {
        '@type': 'Offer',
        url: `${env.SITE_URL}/p/${canonicalHandle}`,
        priceCurrency: product.currency,
        price: (product.price / 100).toFixed(2),
        availability: inStock
          ? 'https://schema.org/InStock'
          : 'https://schema.org/OutOfStock',
        seller: { '@type': 'Organization', name: item.brand_name },
      },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: env.SITE_URL },
        {
          '@type': 'ListItem',
          position: 2,
          name: label(product.category),
          item: `${env.SITE_URL}/search?q=${encodeURIComponent(product.category.replace(/-/g, ' '))}`,
        },
        {
          '@type': 'ListItem',
          position: 3,
          name: item.brand_name,
          item: `${env.SITE_URL}/brand/${item.brand_slug}`,
        },
        { '@type': 'ListItem', position: 4, name: product.title },
      ],
    },
  ];

  const body = `
<div class="wrap">
  <nav class="tiny" aria-label="Breadcrumb" style="padding:var(--s4) 0">
    <a href="/">Home</a> ·
    <a href="/search?q=${encodeURIComponent(product.category.replace(/-/g, ' '))}">${esc(label(product.category))}</a> ·
    <a href="/brand/${esc(item.brand_slug)}">${esc(item.brand_name)}</a>
  </nav>

  <div class="pdp">
    <div class="pdp-gallery">
      ${
        images.length
          ? images
              .slice(0, 5)
              .map(
                (src, i) =>
                  `<img src="${esc(imageUrl(src, i === 0 ? 900 : 480))}" alt="${esc(`${item.brand_name} ${product.title}${i ? `, view ${i + 1}` : ''}`)}"
                    width="${i === 0 ? 900 : 480}" height="${i === 0 ? 1125 : 640}"
                    ${i === 0 ? 'loading="eager" fetchpriority="high"' : 'loading="lazy"'} decoding="async">`,
              )
              .join('')
          : '<div style="aspect-ratio:4/5;background:var(--surface-sunken)"></div>'
      }
    </div>

    <div class="pdp-info">
      <a class="eyebrow" href="/brand/${esc(item.brand_slug)}">${esc(item.brand_name)}</a>
      <h1>${esc(product.title)}</h1>
      ${priceBlock(product, 'pdp')}

      ${
        product.sizes.length
          ? `<div><span class="eyebrow">Sizes</span>
            <div class="size-list">${product.sizes
              .map((s) => `<span class="chip">${esc(s.toUpperCase())}</span>`)
              .join('')}</div></div>`
          : ''
      }

      <div class="trust-block">
        <dl>
          <dt>Brand trust</dt><dd>${item.brand_trust}/100</dd>
          ${item.brand_ship_days ? `<dt>Ships in</dt><dd>${item.brand_ship_days} days</dd>` : ''}
          ${row.brand_return_days ? `<dt>Returns</dt><dd>${Number(row.brand_return_days)} days</dd>` : ''}
          <dt>Availability</dt><dd>${inStock ? (product.availability === 'low_stock' ? 'Low stock' : 'In stock') : 'Out of stock'}</dd>
          <dt>Price checked</dt><dd>${esc(timeAgo(product.last_verified_at))}</dd>
        </dl>
      </div>

      <a class="btn btn-primary btn-block" href="/go/${esc(product.id)}"
         rel="nofollow noopener${row.brand_affiliate_tmpl ? ' sponsored' : ''}" target="_blank"
         style="margin-bottom:var(--s3)">
        View on ${esc(item.brand_name)} ${ICONS.arrow}
      </a>

      <div class="row" style="margin-bottom:var(--s5)">
        <button class="btn btn-sm" type="button" data-save="${esc(product.id)}"
          aria-pressed="${saved.has(product.id) ? 'true' : 'false'}">
          ${ICONS.heart} <span>${saved.has(product.id) ? 'Saved' : 'Save'}</span>
        </button>
        <button class="btn btn-sm" type="button" data-alert="${esc(product.id)}"
          data-kind="${alertKind}" aria-pressed="${alertArmed ? 'true' : 'false'}">
          ${ICONS.bell} <span>${alertArmed ? 'Alert set' : inStock ? 'Alert on price drop' : 'Tell me when it’s back'}</span>
        </button>
        <a class="btn btn-sm" href="/look-builder?seed=${encodeURIComponent(product.id)}">Build a look</a>
      </div>

      ${
        priceHistory.length > 2
          ? `<div style="margin-bottom:var(--s5)">
            <span class="eyebrow">Price history</span>
            ${sparkline(priceHistory)}
            <p class="tiny" style="margin-top:var(--s1)">
              Low ${esc(formatINR(Math.min(...priceHistory)))} · High ${esc(formatINR(Math.max(...priceHistory)))}
            </p>
          </div>`
          : ''
      }

      ${
        product.description
          ? `<div style="margin-bottom:var(--s5)"><span class="eyebrow">About</span>
            <p style="margin-top:var(--s2)">${esc(truncate(product.description, 700))}</p></div>`
          : ''
      }

      <dl class="attr-list">
        <dt>Category</dt><dd>${esc(label(product.category))}</dd>
        ${product.materials.length ? `<dt>Fabric</dt><dd>${esc(product.materials.map(label).join(', '))}</dd>` : ''}
        ${product.colors.length ? `<dt>Colour</dt><dd>${esc(product.colors.map(label).join(', '))}</dd>` : ''}
        ${product.occasions.length ? `<dt>Good for</dt><dd>${esc(product.occasions.map(label).join(', '))}</dd>` : ''}
        ${
          Object.entries(product.attributes)
            .slice(0, 6)
            .map(([k, v]) => `<dt>${esc(label(k))}</dt><dd>${esc(String(v))}</dd>`)
            .join('')
        }
      </dl>

      <p class="tiny">
        <button class="btn btn-sm" type="button" data-report="${esc(product.id)}">Report a problem with this listing</button>
      </p>
      <p class="disclosure">
        You buy directly from ${esc(item.brand_name)}. Price and availability shown
        as last checked may differ on the brand's site.${row.brand_affiliate_tmpl ? ' This is an affiliate link; Vestiq may earn a commission without changing your price or the organic ranking.' : ''}
      </p>
    </div>
  </div>

  ${
    similar.length
      ? `<section class="section">
        ${sectionHead('You might also like')}
        ${productGrid(similar, { now: Date.now() })}
      </section>`
      : ''
  }
</div>`;

  return c.html(
    layout(
      {
        env,
        title: `${truncate(product.title, 55)} by ${item.brand_name} — ${env.SITE_NAME}`,
        description: `${product.title} by ${item.brand_name}, ${formatINR(product.price)}. ${truncate(
          product.description ?? `${label(product.category)} in ${product.colors.map(label).join(', ')}.`,
          120,
        )}`,
        path: `/p/${canonicalHandle}`,
        nonce: app.nonce,
        jsonLd,
        ogImage: product.image_url ?? undefined,
        showHeaderSearch: true,
        showMobileDock: true,
      },
      body,
    ),
  );
});

// ============================================================ brands

pageRoutes.get('/brands', async (c) => {
  const { app } = c.var;
  const env = c.env;
  const res = await env.DB.prepare(
    `SELECT * FROM ${T.brands} WHERE status = 'active'
     ORDER BY trust_score DESC, product_count DESC LIMIT 120`,
  ).all<Record<string, unknown>>();
  const brands = (res.results ?? []).map(rowToBrand);

  return c.html(
    layout(
      {
        env,
        title: `All brands — ${env.SITE_NAME}`,
        description: `Browse ${brands.length}+ independent fashion labels indexed by ${env.SITE_NAME}.`,
        path: '/brands',
        nonce: app.nonce,
        showHeaderSearch: true,
        showMobileDock: true,
        activeNav: 'brands',
      },
      `<div class="wrap"><section class="section">
        <h1>Brands</h1>
        <p class="muted" style="margin:var(--s3) 0 var(--s6)">
          Independent labels, mostly small, mostly ones you won't find on the big marketplaces.
        </p>
        <div class="grid">${brands.map(brandCard).join('')}</div>
      </section></div>`,
    ),
  );
});

pageRoutes.get('/brand/:slug', async (c) => {
  const { app } = c.var;
  const env = c.env;
  const slug = c.req.param('slug');
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10) || 1);

  const row = await env.DB.prepare(
    `SELECT * FROM ${T.brands} WHERE slug = ? AND status = 'active'`,
  )
    .bind(slug)
    .first<Record<string, unknown>>();
  if (!row) return c.notFound();
  const brand = rowToBrand(row);

  const followed = await env.DB.prepare(
    `SELECT 1 AS ok FROM ${T.brandFollows} WHERE owner_key = ? AND brand_id = ?`,
  )
    .bind(ownerKey(app.session), brand.id)
    .first<{ ok: number }>();

  const response = await search(env, {
    query: brand.name,
    parse: { ...heuristicParse(''), semantic_text: '', confidence: 0.2 },
    brandId: brand.id,
    page,
    perPage: 24,
    sort: 'newest',
    session: app.session,
  });

  const jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'Brand',
      name: brand.name,
      description: brand.description ?? undefined,
      url: `${env.SITE_URL}/brand/${brand.slug}`,
      ...(brand.logo_url ? { logo: brand.logo_url } : {}),
      ...(brand.domain ? { sameAs: [`https://${brand.domain.replace(/^https?:\/\//, '')}`] } : {}),
    },
  ];

  return c.html(
    layout(
      {
        env,
        title: `${brand.name} — ${env.SITE_NAME}`,
        description: truncate(
          brand.description ??
            `Shop ${brand.product_count} pieces from ${brand.name}${brand.city ? `, ${brand.city}` : ''}.`,
          150,
        ),
        path: `/brand/${brand.slug}${page > 1 ? `?page=${page}` : ''}`,
        nonce: app.nonce,
        jsonLd,
        showHeaderSearch: true,
        showMobileDock: true,
        activeNav: 'brands',
      },
      `<div class="wrap">
        <section class="section">
          <p class="eyebrow">${esc([brand.city, brand.country].filter(Boolean).join(', '))}</p>
          <h1>${esc(brand.name)}</h1>
          ${brand.description ? `<p class="muted" style="margin-top:var(--s3)">${esc(brand.description)}</p>` : ''}
          <ul class="chips" style="margin-top:var(--s4)">
            <li class="chip">Trust ${brand.trust_score}/100</li>
            ${brand.ship_days ? `<li class="chip">Ships in ${brand.ship_days}d</li>` : ''}
            ${brand.return_days ? `<li class="chip">${brand.return_days}d returns</li>` : ''}
            <li class="chip">${brand.product_count} pieces</li>
          </ul>
          <form method="POST" action="/brand/${esc(brand.slug)}/follow" style="margin-top:var(--s4)">
            <input type="hidden" name="action" value="${followed ? 'unfollow' : 'follow'}">
            <button class="btn btn-sm" type="submit">${followed ? 'Following · Unfollow' : 'Follow this brand'}</button>
          </form>
        </section>
        ${
          response.items.length
            ? `${productGrid(response.items, { now: Date.now() })}
               ${pagination(page, response.has_more, `/brand/${brand.slug}`)}`
            : `<p class="muted">No pieces live from this brand right now.</p>`
        }
      </div>`,
    ),
  );
});

pageRoutes.post('/brand/:slug/follow', async (c) => {
  const slug = c.req.param('slug');
  const brand = await c.env.DB.prepare(`SELECT id FROM ${T.brands} WHERE slug = ? AND status = 'active'`)
    .bind(slug)
    .first<{ id: string }>();
  if (!brand) return c.notFound();
  const form = await c.req.formData();
  const action = String(form.get('action') ?? 'follow');
  const owner = ownerKey(c.var.app.session);
  if (action === 'unfollow') {
    await c.env.DB.prepare(`DELETE FROM ${T.brandFollows} WHERE owner_key = ? AND brand_id = ?`)
      .bind(owner, brand.id)
      .run();
  } else {
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO ${T.brandFollows} (id, owner_key, brand_id, created_at) VALUES (?,?,?,?)`,
    )
      .bind(newId('bf'), owner, brand.id, Date.now())
      .run();
  }
  return c.redirect(`/brand/${encodeURIComponent(slug)}`, 303);
});

// ============================================================ inventory sources

pageRoutes.get('/sources', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT b.name, b.slug, b.domain, b.trust_score,
            COUNT(p.id) AS product_count, MAX(p.last_verified_at) AS last_verified_at,
            GROUP_CONCAT(DISTINCT p.category) AS categories,
            MAX(COALESCE(m.feed_type, 'authorised')) AS feed_type
     FROM ${T.brands} b
     JOIN ${T.products} p ON p.brand_id = b.id AND p.status = 'active'
     LEFT JOIN ${T.merchants} m ON m.brand_id = b.id
     WHERE b.status = 'active'
     GROUP BY b.id ORDER BY product_count DESC, b.name ASC LIMIT 200`,
  ).all<Record<string, unknown>>();
  const sources = rows.results ?? [];
  const products = sources.reduce((sum, row) => sum + Number(row.product_count ?? 0), 0);
  const feedLabel = (value: unknown) => {
    const labels: Record<string, string> = {
      shopify: 'Shopify live feed',
      gmc: 'Google Merchant feed',
      csv: 'Merchant CSV feed',
      souled_store: 'Authorised live catalogue',
      authorised: 'Authorised catalogue',
    };
    return labels[String(value)] ?? 'Authorised catalogue';
  };
  return c.html(
    layout(
      {
        env: c.env,
        title: `Inventory sources — ${c.env.SITE_NAME}`,
        description: 'See exactly which merchant catalogues power Vestiq search and when they were checked.',
        path: '/sources',
        nonce: c.var.app.nonce,
        showHeaderSearch: true,
      },
      `<div class="wrap"><section class="section page-intro">
        <p class="eyebrow">Catalogue transparency</p><h1>Every result has a real source.</h1>
        <p class="muted">Vestiq indexes merchant-authorised feeds and public collections. We do not invent products or hold stock.</p>
        <div class="stat-row"><div class="stat"><div class="label">Live sources</div><div class="value">${sources.length}</div></div>
          <div class="stat"><div class="label">Live pieces</div><div class="value">${products.toLocaleString('en-IN')}</div></div>
          <div class="stat"><div class="label">Refresh model</div><div class="value stat-text">Automatic</div></div></div>
      </section>
      <div class="source-grid">${sources.map((source) => {
        const categories = String(source.categories ?? '').split(',').filter(Boolean).slice(0, 4);
        return `<article class="source-card"><div class="row-between"><div><p class="eyebrow">${esc(feedLabel(source.feed_type))}</p>
          <h2><a href="/brand/${esc(String(source.slug))}">${esc(String(source.name))}</a></h2></div>
          <span class="trust-score">${Number(source.trust_score)}/100</span></div>
          <p class="tiny">${Number(source.product_count).toLocaleString('en-IN')} live pieces · checked ${esc(timeAgo(Number(source.last_verified_at)))}</p>
          <ul class="chips">${categories.map((category) => `<li class="chip">${esc(label(category))}</li>`).join('')}</ul>
        </article>`;
      }).join('') || '<p class="muted">No live merchant sources yet.</p>'}</div>
      <section class="section callout-panel"><div><p class="eyebrow">Merchant-ready</p><h2>Add another store without code.</h2>
        <p class="muted">Shopify, Google Merchant XML, CSV and authorised live catalogues are supported.</p></div>
        <a class="btn btn-primary" href="/merchant/signup">Connect a store</a></section></div>`,
    ),
  );
});

// ============================================================ collections

pageRoutes.get('/collections', async (c) => {
  const { app } = c.var;
  const env = c.env;
  const res = await env.DB.prepare(
    `SELECT * FROM ${T.collections} WHERE status = 'active' AND item_count > 0
     ORDER BY item_count DESC LIMIT 120`,
  ).all<Record<string, unknown>>();
  const rows = res.results ?? [];

  return c.html(
    layout(
      {
        env,
        title: `Collections — ${env.SITE_NAME}`,
        description: 'Curated edits across independent fashion brands.',
        path: '/collections',
        nonce: app.nonce,
        showHeaderSearch: true,
        showMobileDock: true,
      },
      `<div class="wrap"><section class="section">
        <h1>Collections</h1>
        <p class="muted" style="margin:var(--s3) 0 var(--s6)">Edits we keep updated as new pieces land.</p>
        ${chipLinks(
          rows.map((r) => ({
            label: `${String(r.title)} (${Number(r.item_count)})`,
            href: `/c/${String(r.slug)}`,
          })),
        )}
      </section></div>`,
    ),
  );
});

pageRoutes.get('/c/:slug', async (c) => {
  const { app } = c.var;
  const env = c.env;
  const slug = c.req.param('slug');
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10) || 1);

  const row = await env.DB.prepare(
    `SELECT * FROM ${T.collections} WHERE slug = ? AND status = 'active'`,
  )
    .bind(slug)
    .first<Record<string, unknown>>();
  if (!row) return c.notFound();

  const filters = safeJson<Partial<ParsedQuery>>(row.filters as string, {});
  const parse: ParsedQuery = { ...heuristicParse(''), ...filters, confidence: 0.9 };

  const response = await search(env, {
    query: String(row.title),
    parse,
    page,
    perPage: 24,
    sort: 'relevance',
    session: app.session,
  });

  const indexable = Number(row.indexable) === 1 && response.total >= 12;

  return c.html(
    layout(
      {
        env,
        title: `${String(row.title)} — ${env.SITE_NAME}`,
        description: truncate(
          String(row.description ?? `${response.total} pieces in ${String(row.title)}.`),
          150,
        ),
        path: `/c/${slug}${page > 1 ? `?page=${page}` : ''}`,
        nonce: app.nonce,
        noindex: !indexable,
        showHeaderSearch: true,
        showMobileDock: true,
        jsonLd:
          response.items.length > 0
            ? [
                {
                  '@context': 'https://schema.org',
                  '@type': 'ItemList',
                  name: String(row.title),
                  // Count what is actually in the list, not the overall (possibly capped) total.
              numberOfItems: Math.min(response.items.length, 24),
                  itemListElement: response.items.slice(0, 24).map((item, i) => ({
                    '@type': 'ListItem',
                    position: (page - 1) * 24 + i + 1,
                    url: `${env.SITE_URL}/p/${item.slug}-${item.id}`,
                    name: item.title,
                  })),
                },
              ]
            : [],
      },
      `<div class="wrap">
        <section class="section">
          ${row.subtitle ? `<p class="eyebrow">${esc(String(row.subtitle))}</p>` : ''}
          <h1>${esc(String(row.title))}</h1>
          ${row.description ? `<p class="muted" style="margin-top:var(--s3);max-width:68ch">${esc(String(row.description))}</p>` : ''}
          <p class="tiny" style="margin-top:var(--s3)">${response.total}${response.capped ? '+' : ''} pieces</p>
        </section>
        ${
          response.items.length
            ? `${productGrid(response.items, { now: Date.now() })}
               ${pagination(page, response.has_more, `/c/${slug}`)}`
            : `<p class="muted">This edit is empty right now — check back soon.</p>`
        }
      </div>`,
    ),
  );
});

// ============================================================ drops

pageRoutes.get('/drops', async (c) => {
  const { app } = c.var;
  const env = c.env;
  const follows = await env.DB.prepare(
    `SELECT brand_id FROM ${T.brandFollows} WHERE owner_key = ? ORDER BY created_at DESC LIMIT 50`,
  )
    .bind(ownerKey(app.session))
    .all<{ brand_id: string }>();
  const followedBrandIds = (follows.results ?? []).map((row) => row.brand_id);
  const items = await latestProducts(env, 48, followedBrandIds, app.session);
  const saved = await savedIds(env, ownerKey(app.session), items.map((i) => i.id));

  return c.html(
    layout(
      {
        env,
        title: `New in — ${env.SITE_NAME}`,
        description: 'The newest pieces from independent brands, updated daily.',
        path: '/drops',
        nonce: app.nonce,
        showHeaderSearch: true,
        showMobileDock: true,
        activeNav: 'drops',
      },
      `<div class="wrap"><section class="section">
        <h1>New in</h1>
        <p class="muted" style="margin:var(--s3) 0 var(--s6)">${
          followedBrandIds.length || app.session.taste
            ? 'Personalised with followed brands and your taste preferences.'
            : `Freshest pieces we've indexed. <a href="/taste">Set your taste</a> or follow brands to personalise this feed.`
        }</p>
        ${items.length ? productGrid(items, { savedIds: saved, now: Date.now() }) : '<p class="muted">Nothing new yet.</p>'}
      </section></div>`,
    ),
  );
});

// ============================================================ wardrobe

pageRoutes.get('/wardrobe', async (c) => {
  const { app } = c.var;
  const env = c.env;
  const owner = ownerKey(app.session);

  const savesRes = await env.DB.prepare(
    `SELECT ${PRODUCT_COLUMNS}, s.created_at AS saved_at
     FROM ${T.saves} s
     JOIN ${T.products} p ON p.id = s.product_id
     JOIN ${T.brands} b ON b.id = p.brand_id
     WHERE s.owner_key = ?
     ORDER BY s.created_at DESC LIMIT 120`,
  )
    .bind(owner)
    .all<Record<string, unknown>>();

  const items: ResultItem[] = (savesRes.results ?? []).map((row) => ({
    ...rowToProduct(row),
    brand_name: String(row.brand_name),
    brand_slug: String(row.brand_slug),
    brand_trust: Number(row.brand_trust ?? 50),
    brand_ship_days:
      row.brand_ship_days === null || row.brand_ship_days === undefined
        ? null
        : Number(row.brand_ship_days),
    score: 0,
    match_reasons: [],
  }));

  const alertsRes = await env.DB.prepare(
    `SELECT a.id, a.kind, a.target_price, a.base_price, a.status, p.id AS product_id,
            p.title, p.slug, p.price, b.name AS brand_name
     FROM ${T.alerts} a
     JOIN ${T.products} p ON p.id = a.product_id
     JOIN ${T.brands} b ON b.id = p.brand_id
     WHERE a.owner_key = ? ORDER BY a.created_at DESC LIMIT 50`,
  )
    .bind(owner)
    .all<Record<string, unknown>>();

  const intentsRes = await env.DB.prepare(
    `SELECT id, query_raw, last_count, last_run_at FROM ${T.savedIntents}
     WHERE owner_key = ? AND status = 'active' ORDER BY created_at DESC LIMIT 30`,
  )
    .bind(owner)
    .all<{ id: string; query_raw: string; last_count: number; last_run_at: number | null }>();

  const alerts = alertsRes.results ?? [];
  const intents = intentsRes.results ?? [];
  const followsRes = await env.DB.prepare(
    `SELECT b.name, b.slug FROM ${T.brandFollows} f JOIN ${T.brands} b ON b.id = f.brand_id
     WHERE f.owner_key = ? AND b.status = 'active' ORDER BY f.created_at DESC LIMIT 50`,
  )
    .bind(owner)
    .all<{ name: string; slug: string }>();
  const followedBrands = followsRes.results ?? [];
  const looksRes = await env.DB.prepare(
    `SELECT id, title, total_price, created_at FROM ${T.looks}
     WHERE owner_key = ? AND status = 'active' ORDER BY created_at DESC LIMIT 30`,
  )
    .bind(owner)
    .all<{ id: string; title: string; total_price: number; created_at: number }>();
  const looks = looksRes.results ?? [];
  const tripsRes = await env.DB.prepare(
    `SELECT id, title, destination, days, total_price, created_at FROM ${T.trips}
     WHERE owner_key = ? AND status = 'active' ORDER BY created_at DESC LIMIT 20`,
  )
    .bind(owner)
    .all<{ id: string; title: string; destination: string; days: number; total_price: number; created_at: number }>();
  const trips = tripsRes.results ?? [];

  return c.html(
    layout(
      {
        env,
        title: `Saved — ${env.SITE_NAME}`,
        description: 'Your saved pieces, price alerts and standing searches.',
        path: '/wardrobe',
        nonce: app.nonce,
        noindex: true,
        showHeaderSearch: true,
        showMobileDock: true,
        activeNav: 'wardrobe',
      },
      `<div class="wrap">
        <section class="section">
          <h1>Your wardrobe</h1>
          <p class="action-row"><a class="btn btn-sm" href="/profile">Fit profile</a> <a class="btn btn-sm" href="/taste">Tune your taste</a> <a class="btn btn-sm" href="/trip-planner">Plan a trip</a> <a class="btn btn-sm" href="/account">Cross-device account</a></p>
          ${
            app.session.user_id
              ? ''
              : `<div class="notice" style="margin-top:var(--s4)">
                  Saved pieces stay with this browser. You can add an email when
                  setting an alert so we can notify you.
                </div>`
          }
        </section>

        ${
          items.length
            ? productGrid(items, {
                savedIds: new Set(items.map((i) => i.id)),
                now: Date.now(),
              })
            : `<p class="muted">Nothing saved yet. Tap the heart on anything you like.</p>`
        }

        ${
          alerts.length
            ? `<section class="section">
              ${sectionHead('Alerts')}
              <div class="table-wrap"><table>
                <thead><tr><th>Piece</th><th>Type</th><th class="num">Watching from</th><th>Status</th></tr></thead>
                <tbody>${alerts
                  .map(
                    (a) => `<tr>
                      <td><a href="/p/${esc(String(a.slug))}-${esc(String(a.product_id ?? ''))}">${esc(truncate(String(a.title), 40))}</a> <span class="tiny">${esc(String(a.brand_name))}</span></td>
                      <td>${a.kind === 'price_drop' ? 'Price drop' : 'Back in stock'}</td>
                      <td class="num">${esc(formatINR(Number(a.base_price)))}</td>
                      <td><span class="badge ${a.status === 'fired' ? 'good' : ''}">${esc(String(a.status))}</span>
                        ${
                          a.status === 'armed'
                            ? `<form method="POST" action="/wardrobe/alerts/${esc(String(a.id))}/cancel" style="display:inline;margin-left:var(--s2)"><button class="btn btn-sm" type="submit">Cancel</button></form>`
                            : ''
                        }
                      </td>
                    </tr>`,
                  )
                  .join('')}</tbody>
              </table></div>
            </section>`
            : ''
        }

        ${
          intents.length
            ? `<section class="section">
              ${sectionHead('Standing searches')}
              <p class="tiny" style="margin-bottom:var(--s4)">We re-run these nightly and tell you what's new.</p>
              <div class="table-wrap"><table>
                <thead><tr><th>Search</th><th class="num">New</th><th>Last checked</th><th></th></tr></thead>
                <tbody>${intents
                  .map(
                    (i) => `<tr><td><a href="/search?q=${encodeURIComponent(i.query_raw)}">${esc(truncate(i.query_raw, 70))}</a></td>
                      <td class="num">${i.last_count}</td><td>${esc(timeAgo(i.last_run_at))}</td>
                      <td><form method="POST" action="/wardrobe/intents/${esc(i.id)}/cancel"><button class="btn btn-sm" type="submit">Stop</button></form></td></tr>`,
                  )
                  .join('')}</tbody>
              </table></div>
            </section>`
            : ''
        }
        ${
          trips.length
            ? `<section class="section">${sectionHead('Trip wardrobes')}
                <div class="table-wrap"><table><thead><tr><th>Trip</th><th>Days</th><th class="num">Planned</th><th></th></tr></thead>
                <tbody>${trips.map((trip) => `<tr><td><a href="/trips/${esc(trip.id)}">${esc(trip.title)}</a><span class="tiny"> ${esc(trip.destination)}</span></td>
                  <td>${trip.days}</td><td class="num">${esc(formatINR(trip.total_price))}</td>
                  <td><form method="POST" action="/wardrobe/trips/${esc(trip.id)}/remove"><button class="btn btn-sm" type="submit">Remove</button></form></td></tr>`).join('')}</tbody></table></div></section>`
            : ''
        }
        ${
          followedBrands.length
            ? `<section class="section">${sectionHead('Followed brands')}${chipLinks(
                followedBrands.map((brand) => ({ label: brand.name, href: `/brand/${brand.slug}` })),
              )}</section>`
            : ''
        }
        ${
          looks.length
            ? `<section class="section">${sectionHead('Saved looks')}
                <div class="table-wrap"><table><thead><tr><th>Look</th><th class="num">Total</th><th>Created</th><th></th></tr></thead>
                <tbody>${looks
                  .map(
                    (look) => `<tr><td><a href="/looks/${esc(look.id)}">${esc(truncate(look.title, 60))}</a></td>
                      <td class="num">${esc(formatINR(look.total_price))}</td><td>${esc(timeAgo(look.created_at))}</td>
                      <td><form method="POST" action="/wardrobe/looks/${esc(look.id)}/remove"><button class="btn btn-sm" type="submit">Remove</button></form></td></tr>`,
                  )
                  .join('')}</tbody></table></div></section>`
            : ''
        }
      </div>`,
    ),
  );
});

pageRoutes.post('/wardrobe/alerts/:id/cancel', async (c) => {
  await c.env.DB.prepare(
    `UPDATE ${T.alerts} SET status = 'cancelled'
     WHERE id = ? AND owner_key = ? AND status = 'armed'`,
  )
    .bind(c.req.param('id'), ownerKey(c.var.app.session))
    .run();
  return c.redirect('/wardrobe', 303);
});

pageRoutes.post('/wardrobe/intents/:id/cancel', async (c) => {
  await c.env.DB.prepare(
    `UPDATE ${T.savedIntents} SET status = 'cancelled' WHERE id = ? AND owner_key = ?`,
  )
    .bind(c.req.param('id'), ownerKey(c.var.app.session))
    .run();
  return c.redirect('/wardrobe', 303);
});

pageRoutes.post('/wardrobe/looks/:id/remove', async (c) => {
  const id = c.req.param('id');
  const owner = ownerKey(c.var.app.session);
  const owned = await c.env.DB.prepare(`SELECT id FROM ${T.looks} WHERE id = ? AND owner_key = ?`)
    .bind(id, owner)
    .first<{ id: string }>();
  if (owned) {
    await c.env.DB.batch([
      c.env.DB.prepare(`DELETE FROM ${T.lookItems} WHERE look_id = ?`).bind(id),
      c.env.DB.prepare(`UPDATE ${T.looks} SET status = 'removed' WHERE id = ?`).bind(id),
    ]);
  }
  return c.redirect('/wardrobe', 303);
});

pageRoutes.post('/wardrobe/trips/:id/remove', async (c) => {
  const id = c.req.param('id');
  const owner = ownerKey(c.var.app.session);
  const owned = await c.env.DB.prepare(`SELECT id FROM ${T.trips} WHERE id = ? AND owner_key = ?`)
    .bind(id, owner)
    .first<{ id: string }>();
  if (owned) {
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE ${T.looks} SET status = 'removed' WHERE id IN (SELECT look_id FROM ${T.tripLooks} WHERE trip_id = ?)`).bind(id),
      c.env.DB.prepare(`UPDATE ${T.trips} SET status = 'removed' WHERE id = ?`).bind(id),
    ]);
  }
  return c.redirect('/wardrobe', 303);
});

pageRoutes.get('/save-search', async (c) => {
  const query = (c.req.query('q') ?? '').trim().slice(0, 300);
  if (query.length < 3) return c.redirect('/search', 302);
  const user = c.var.app.session.user_id
    ? await c.env.DB.prepare(`SELECT email FROM ${T.users} WHERE id = ?`)
        .bind(c.var.app.session.user_id)
        .first<{ email: string | null }>()
    : null;
  return c.html(
    layout(
      {
        env: c.env,
        title: `Save search — ${c.env.SITE_NAME}`,
        description: 'Get an email when new pieces match this search.',
        path: `/save-search?q=${encodeURIComponent(query)}`,
        nonce: c.var.app.nonce,
        noindex: true,
        showHeaderSearch: true,
      },
      `<div class="wrap-narrow"><section class="section">
        <p class="eyebrow">Standing search</p><h1>Save this search</h1>
        <div class="notice" style="margin-top:var(--s4)">${esc(query)}</div>
        <p class="muted">We’ll check daily and email only when genuinely new pieces appear.</p>
        <form method="POST" action="/save-search" style="margin-top:var(--s5)">
          <input type="hidden" name="query" value="${esc(query)}">
          <label class="field"><span>Email address</span>
            <input type="email" name="email" value="${esc(user?.email ?? '')}" required autocomplete="email"></label>
          <button class="btn btn-primary" type="submit">Save search</button>
        </form>
      </section></div>`,
    ),
  );
});

pageRoutes.post('/save-search', async (c) => {
  const limited = await rateLimit(c.env, 'write', rateIdentity(c.req.raw, c.var.app.session.id));
  if (!limited.ok) return c.text('Too many requests. Try again later.', 429);
  const form = await c.req.formData();
  const query = String(form.get('query') ?? '').trim().slice(0, 300);
  const email = String(form.get('email') ?? '').trim().toLowerCase().slice(0, 200);
  if (query.length < 3 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.text('Check the search and email address.', 400);
  }
  const initial = await search(c.env, { query, perPage: 24, session: c.var.app.session });
  await c.env.DB.prepare(
    `INSERT INTO ${T.savedIntents}
      (id, owner_key, query_raw, parse, email, seen_ids, last_run_at, status, created_at)
     VALUES (?,?,?,?,?,?,?, 'active', ?)
     ON CONFLICT(owner_key, query_raw) DO UPDATE SET status = 'active', email = excluded.email,
       parse = excluded.parse, seen_ids = excluded.seen_ids, last_run_at = excluded.last_run_at`,
  )
    .bind(
      newId('si'),
      ownerKey(c.var.app.session),
      query,
      JSON.stringify(initial.parse),
      email,
      JSON.stringify(initial.items.map((item) => item.id)),
      Date.now(),
      Date.now(),
    )
    .run();
  return c.redirect('/wardrobe?saved_search=1', 303);
});

// ============================================================ stylist

pageRoutes.get('/stylist', async (c) => {
  const { app } = c.var;
  const env = c.env;
  const seed = (c.req.query('q') ?? '').slice(0, 300);

  const openers = [
    'Packing for 5 days in Goa, total budget ₹10,000',
    'I have olive wide-leg trousers — build me 3 outfits',
    'Office wardrobe refresh under ₹15,000',
    'Wedding guest, outdoor afternoon, not a saree',
  ];

  return c.html(
    layout(
      {
        env,
        title: `Stylist — ${env.SITE_NAME}`,
        description:
          'Talk to a stylist that can actually shop. Describe the occasion, the budget and what you own.',
        path: '/stylist',
        nonce: app.nonce,
        showHeaderSearch: true,
        activeNav: 'stylist',
      },
      `<div class="chat" id="chat" data-seed="${esc(seed)}">
        <section style="padding-bottom:var(--s6)">
          <h1>Stylist</h1>
          <p class="muted" style="margin-top:var(--s3)">
            Tell me the occasion, your budget, and what you already own. I'll put
            real outfits together from brands we index.
          </p>
          <p style="margin-top:var(--s3)"><a class="btn btn-sm" href="/look-builder">Build a budgeted, shareable look</a></p>
        </section>

        <div id="thread" aria-live="polite"></div>

        <div id="openers">
          <p class="eyebrow" style="margin-bottom:var(--s3)">Try</p>
          <ul class="chips">
            ${openers
              .map(
                (o) =>
                  `<li><button class="chip" type="button" data-opener="${esc(o)}">${esc(o)}</button></li>`,
              )
              .join('')}
          </ul>
        </div>

        <div class="chat-composer">
          <form id="chat-form">
            <div class="searchbar">
              <div style="display:flex;align-items:flex-end;gap:var(--s2);background:var(--surface);border:1px solid var(--line);border-radius:var(--r-pill);padding:var(--s2) var(--s2) var(--s2) var(--s5)">
                <label class="sr-only" for="chat-input">Message the stylist</label>
                <textarea id="chat-input" rows="1" placeholder="Describe what you need…"
                  style="flex:1;border:0;background:none;resize:none;padding:var(--s3) 0;max-height:5.5em"></textarea>
                <button class="icon-btn" type="submit" aria-label="Send">${ICONS.arrow}</button>
              </div>
            </div>
            <p class="tiny" style="margin:var(--s2) 0 0;text-align:center">
              Recommendations link to the brand's own store. Vestiq is free to use.
            </p>
          </form>
        </div>
      </div>`,
    ),
  );
});

// ============================================================ full-look builder

pageRoutes.get('/look-builder', async (c) => {
  const seedId = (c.req.query('seed') ?? '').slice(0, 40);
  const prompt = (c.req.query('q') ?? '').slice(0, 300);
  const requestedBudget = heuristicParse(prompt).price_max;
  const budgetRupees = requestedBudget
    ? Math.min(1_000_000, Math.max(500, Math.round(requestedBudget / 100)))
    : 10_000;
  const seed = seedId
    ? await c.env.DB.prepare(
        `SELECT p.title, b.name AS brand_name FROM ${T.products} p JOIN ${T.brands} b ON b.id = p.brand_id
         WHERE p.id = ? AND p.status = 'active' AND b.status = 'active'`,
      )
        .bind(seedId)
        .first<{ title: string; brand_name: string }>()
    : null;
  return c.html(
    layout(
      {
        env: c.env,
        title: `Look builder — ${c.env.SITE_NAME}`,
        description: 'Build a complete outfit within one total budget.',
        path: `/look-builder${seedId ? `?seed=${encodeURIComponent(seedId)}` : ''}`,
        nonce: c.var.app.nonce,
        noindex: true,
        showHeaderSearch: true,
      },
      `<div class="wrap-narrow"><section class="section">
        <p class="eyebrow">Stylist tool</p><h1>Build a complete look</h1>
        <p class="muted">We search each outfit slot, then optimise the combination against your total budget. The result is saved as a shareable page.</p>
        ${hasFitProfile(c.var.app.session) ? '<div class="notice good">Your saved fit profile will influence this look.</div>' : '<p class="tiny"><a href="/profile">Add your sizes</a> before building for fit-aware results.</p>'}
        ${seed ? `<div class="notice">Building around <strong>${esc(seed.title)}</strong> by ${esc(seed.brand_name)}.</div>` : ''}
        <form method="POST" action="/look-builder" style="margin-top:var(--s5)">
          ${seedId ? `<input type="hidden" name="seed" value="${esc(seedId)}">` : ''}
          <label class="field"><span>Occasion, mood and constraints</span>
            <textarea name="prompt" required maxlength="300" placeholder="Outdoor mehendi, breathable, not too traditional">${esc(prompt)}</textarea></label>
          <label class="field"><span>Total budget in ₹</span>
            <input type="number" name="budget" min="500" max="1000000" step="100" value="${budgetRupees}" required></label>
          <button class="btn btn-primary" type="submit">Build my look</button>
        </form>
      </section></div>`,
    ),
  );
});

pageRoutes.post('/look-builder', async (c) => {
  const limited = await rateLimit(c.env, 'stylist', rateIdentity(c.req.raw, c.var.app.session.id));
  if (!limited.ok) return c.text('Too many look requests. Try again later.', 429);
  const form = await c.req.formData();
  const prompt = String(form.get('prompt') ?? '').trim().slice(0, 300);
  const seedId = String(form.get('seed') ?? '').slice(0, 40);
  const budgetRupees = Number(form.get('budget'));
  if (prompt.length < 3 || !Number.isFinite(budgetRupees) || budgetRupees < 500 || budgetRupees > 1_000_000) {
    return c.text('Check the prompt and budget.', 400);
  }

  // Fit is already applied as a bounded ranking signal through `session`.
  // Appending it to the shopper's text made preferences such as "top size M"
  // look like hard product constraints (and even an inferred `tops` category),
  // which could collapse a broad request such as "outdoor" to zero pieces.
  const built = await buildBudgetedLook(c.env, prompt, Math.round(budgetRupees * 100), c.var.app.session, seedId || undefined);
  if (!built.items.length) {
    return c.html(
      layout(
        {
          env: c.env,
          title: `No complete look — ${c.env.SITE_NAME}`,
          description: 'No products fit the requested look.',
          path: '/look-builder',
          nonce: c.var.app.nonce,
          noindex: true,
        },
        `<div class="wrap-narrow"><section class="section"><h1>We couldn’t build that look yet.</h1><p class="muted">The catalogue does not have enough matching pieces inside ${esc(formatINR(Math.round(budgetRupees * 100)))}. Try a wider description or budget.</p><p><a class="btn" href="/look-builder">Try again</a></p></section></div>`,
      ),
      422,
    );
  }

  const lookId = newId('lk');
  const title = truncate(`Look for ${prompt}`, 100);
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO ${T.looks} (id, owner_key, title, prompt, budget, total_price, created_at) VALUES (?,?,?,?,?,?,?)`,
    ).bind(lookId, ownerKey(c.var.app.session), title, prompt, Math.round(budgetRupees * 100), built.total, Date.now()),
    ...built.items.map((selection, index) =>
      c.env.DB.prepare(
        `INSERT INTO ${T.lookItems} (look_id, product_id, slot, position) VALUES (?,?,?,?)`,
      ).bind(lookId, selection.item.id, selection.slot, index),
    ),
  ]);
  return c.redirect(`/looks/${lookId}`, 303);
});

pageRoutes.get('/looks/:id', async (c) => {
  const id = c.req.param('id');
  const look = await c.env.DB.prepare(
    `SELECT id, title, prompt, budget, total_price, created_at FROM ${T.looks} WHERE id = ? AND status = 'active'`,
  )
    .bind(id)
    .first<{ id: string; title: string; prompt: string; budget: number | null; total_price: number; created_at: number }>();
  if (!look) return c.notFound();
  const rows = await c.env.DB.prepare(
    `SELECT ${PRODUCT_COLUMNS}, li.slot, li.position FROM ${T.lookItems} li
     JOIN ${T.products} p ON p.id = li.product_id JOIN ${T.brands} b ON b.id = p.brand_id
     WHERE li.look_id = ? AND p.status = 'active' AND b.status = 'active' ORDER BY li.position`,
  )
    .bind(id)
    .all<Record<string, unknown>>();
  const items = (rows.results ?? []).map((row) => ({ slot: String(row.slot), item: toResultItem(row) }));
  return c.html(
    layout(
      {
        env: c.env,
        title: `${look.title} — ${c.env.SITE_NAME}`,
        description: truncate(`${items.length}-piece look for ${look.prompt}, ${formatINR(look.total_price)} total.`, 150),
        path: `/looks/${id}`,
        nonce: c.var.app.nonce,
        showHeaderSearch: true,
        ogImage: items[0]?.item.image_url ?? undefined,
      },
      `<div class="wrap"><section class="section"><p class="eyebrow">Shareable look</p><h1>${esc(look.title)}</h1>
        <p class="muted">${esc(look.prompt)}</p>
        <div class="stat-row" style="margin-top:var(--s5)"><div class="stat"><div class="label">Total</div><div class="value">${esc(formatINR(look.total_price))}</div></div>
          <div class="stat"><div class="label">Budget</div><div class="value">${esc(formatINR(look.budget))}</div></div>
          <div class="stat"><div class="label">Pieces</div><div class="value">${items.length}</div></div></div>
        <label class="field"><span>Share link</span><input class="input" readonly value="${esc(`${c.env.SITE_URL}/looks/${id}`)}" onclick="this.select()"></label>
      </section>
      <div class="look-grid">${items
        .map(
          ({ slot, item }) => `<section><p class="eyebrow">${esc(label(slot))}</p>${productGrid([item], { now: Date.now() })}</section>`,
        )
        .join('')}</div></div>`,
    ),
  );
});

// ============================================================ trip wardrobe planner

pageRoutes.get('/trip-planner', (c) => {
  const fit = c.var.app.session.fit;
  return c.html(
    layout(
      {
        env: c.env,
        title: `Trip wardrobe planner — ${c.env.SITE_NAME}`,
        description: 'Build a day-by-day capsule wardrobe from real, in-stock products within one total budget.',
        path: '/trip-planner',
        nonce: c.var.app.nonce,
        noindex: true,
        showHeaderSearch: true,
        activeNav: 'planner',
      },
      `<div class="wrap planner-shell"><section class="section page-intro">
        <p class="eyebrow">Capsule planner</p><h1>Pack the trip, not random pieces.</h1>
        <p class="muted">Tell us where you are going and what each day looks like. We build distinct daily edits while keeping the whole plan inside one budget.</p>
        ${fit ? `<div class="notice good">Using your saved fit profile. <a href="/profile">Review sizes</a></div>` : '<div class="notice">Add your <a href="/profile">fit profile</a> so available sizes rank first.</div>'}
      </section>
      <div class="planner-layout"><form method="POST" action="/trip-planner" class="planner-form panel">
        <label class="field"><span>Destination</span><input name="destination" required maxlength="60" placeholder="Goa"></label>
        <div class="form-grid">
          <label class="field"><span>Number of days</span><input type="number" name="days" min="1" max="5" value="3" required></label>
          <label class="field"><span>Total shopping budget in ₹</span><input type="number" name="budget" min="1000" max="1000000" step="100" value="12000" required></label>
        </div>
        <label class="field"><span>Plans and occasions</span><textarea name="occasions" maxlength="300" placeholder="Beach day, dinner, sightseeing"></textarea></label>
        <label class="field"><span>Extra constraints</span><textarea name="notes" maxlength="240" placeholder="Breathable, easy to rewear, no heels"></textarea></label>
        <button class="btn btn-primary btn-block" type="submit">Build my trip wardrobe</button>
      </form>
      <aside class="planner-preview panel"><p class="eyebrow">What you get</p><ol class="step-list">
        <li><strong>One edit per day</strong><span>Built from the live catalogue</span></li>
        <li><strong>One shared budget</strong><span>No per-item budget loophole</span></li>
        <li><strong>Your sizes lifted</strong><span>Fit-aware, never over-filtered</span></li>
        <li><strong>A shareable plan</strong><span>Keep it in your wardrobe</span></li>
      </ol></aside></div></div>`,
    ),
  );
});

pageRoutes.post('/trip-planner', async (c) => {
  const limited = await rateLimit(c.env, 'stylist', rateIdentity(c.req.raw, c.var.app.session.id));
  if (!limited.ok) return c.text('Too many planner requests. Try again later.', 429);
  const form = await c.req.formData();
  const destination = String(form.get('destination') ?? '').trim().slice(0, 60);
  const days = Math.round(Number(form.get('days')));
  const budgetRupees = Number(form.get('budget'));
  const notes = String(form.get('notes') ?? '').trim().slice(0, 240);
  const occasions = String(form.get('occasions') ?? '')
    .split(/[,;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 8);
  if (destination.length < 2 || !Number.isInteger(days) || days < 1 || days > 5 || !Number.isFinite(budgetRupees) || budgetRupees < 1_000 || budgetRupees > 1_000_000) {
    return c.text('Check the destination, days, and budget.', 400);
  }

  const budget = Math.round(budgetRupees * 100);
  const planned = await buildTripPlan(c.env, {
    destination,
    days,
    budget,
    occasions,
    notes,
    session: c.var.app.session,
  });
  if (planned.days.length !== days) {
    return c.html(
      layout(
        {
          env: c.env,
          title: `No trip wardrobe yet — ${c.env.SITE_NAME}`,
          description: 'No live products fit this trip plan and budget.',
          path: '/trip-planner',
          nonce: c.var.app.nonce,
          noindex: true,
          showHeaderSearch: true,
        },
        `<div class="wrap-narrow"><section class="section"><h1>We need a little more room.</h1><p class="muted">The live catalogue could not cover this many days inside ${esc(formatINR(budget))}. Try fewer days, a wider description, or a higher budget.</p><a class="btn" href="/trip-planner">Adjust plan</a></section></div>`,
      ),
      422,
    );
  }

  const tripId = newId('tr');
  const created = Date.now();
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT INTO ${T.trips} (id, owner_key, title, destination, days, occasions, budget, total_price, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind(tripId, ownerKey(c.var.app.session), `${destination} · ${days} day wardrobe`, destination, days, JSON.stringify(occasions), budget, planned.total, created),
  ];
  planned.days.forEach((day) => {
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO ${T.looks} (id, owner_key, title, prompt, budget, total_price, created_at) VALUES (?,?,?,?,?,?,?)`,
      ).bind(day.lookId, ownerKey(c.var.app.session), `${destination} day ${day.day}: ${day.label}`, day.prompt, day.budget, day.total, created),
      c.env.DB.prepare(
        `INSERT INTO ${T.tripLooks} (trip_id, look_id, day, label) VALUES (?,?,?,?)`,
      ).bind(tripId, day.lookId, day.day, day.label),
      ...day.items.map((selection, index) =>
        c.env.DB.prepare(
          `INSERT INTO ${T.lookItems} (look_id, product_id, slot, position) VALUES (?,?,?,?)`,
        ).bind(day.lookId, selection.item.id, selection.slot, index),
      ),
    );
  });
  await c.env.DB.batch(statements);
  return c.redirect(`/trips/${tripId}`, 303);
});

pageRoutes.get('/trips/:id', async (c) => {
  const trip = await c.env.DB.prepare(
    `SELECT id, title, destination, days, occasions, budget, total_price, created_at
     FROM ${T.trips} WHERE id = ? AND status = 'active'`,
  )
    .bind(c.req.param('id'))
    .first<{ id: string; title: string; destination: string; days: number; occasions: string; budget: number; total_price: number; created_at: number }>();
  if (!trip) return c.notFound();
  const rows = await c.env.DB.prepare(
    `SELECT tl.day, tl.label, tl.look_id, li.slot, li.position, ${PRODUCT_COLUMNS}
     FROM ${T.tripLooks} tl
     JOIN ${T.looks} l ON l.id = tl.look_id AND l.status = 'active'
     JOIN ${T.lookItems} li ON li.look_id = l.id
     JOIN ${T.products} p ON p.id = li.product_id AND p.status = 'active'
     JOIN ${T.brands} b ON b.id = p.brand_id AND b.status = 'active'
     WHERE tl.trip_id = ? ORDER BY tl.day, li.position`,
  )
    .bind(trip.id)
    .all<Record<string, unknown>>();
  const grouped = new Map<number, { label: string; lookId: string; items: ResultItem[] }>();
  for (const row of rows.results ?? []) {
    const day = Number(row.day);
    const entry = grouped.get(day) ?? { label: String(row.label), lookId: String(row.look_id), items: [] };
    entry.items.push(toResultItem(row));
    grouped.set(day, entry);
  }
  const remaining = Math.max(0, trip.budget - trip.total_price);
  return c.html(
    layout(
      {
        env: c.env,
        title: `${trip.title} — ${c.env.SITE_NAME}`,
        description: `${trip.days}-day wardrobe plan for ${trip.destination} within ${formatINR(trip.budget)}.`,
        path: `/trips/${trip.id}`,
        nonce: c.var.app.nonce,
        noindex: true,
        showHeaderSearch: true,
        activeNav: 'planner',
        ogImage: grouped.values().next().value?.items[0]?.image_url ?? undefined,
      },
      `<div class="wrap"><section class="section trip-hero"><div><p class="eyebrow">Shareable trip wardrobe</p><h1>${esc(trip.title)}</h1>
        <p class="muted">A capsule built only from live merchant inventory. Rewear what you own; buy only what earns a place.</p></div>
        <div class="budget-meter"><div class="row-between tiny"><span>${esc(formatINR(trip.total_price))} planned</span><span>${esc(formatINR(remaining))} left</span></div>
          <div class="meter"><span style="width:${Math.min(100, Math.round((trip.total_price / Math.max(1, trip.budget)) * 100))}%"></span></div></div>
        <label class="field share-field"><span>Share link</span><input readonly value="${esc(`${c.env.SITE_URL}/trips/${trip.id}`)}"></label>
      </section>
      <div class="trip-days">${[...grouped.entries()].map(([day, entry]) => `<section class="trip-day"><div class="trip-day-head"><span class="day-number">${day.toString().padStart(2, '0')}</span><div><p class="eyebrow">Day ${day}</p><h2>${esc(entry.label)}</h2></div><a class="btn btn-sm" href="/looks/${esc(entry.lookId)}">Open look</a></div>
        ${productGrid(entry.items, { now: Date.now() })}</section>`).join('')}</div></div>`,
    ),
  );
});

// ============================================================ shopper account

pageRoutes.get('/account', async (c) => {
  const { app } = c.var;
  const user = app.session.user_id
    ? await c.env.DB.prepare(`SELECT email, name FROM ${T.users} WHERE id = ? AND status = 'active'`)
        .bind(app.session.user_id)
        .first<{ email: string; name: string | null }>()
    : null;

  return c.html(
    layout(
      {
        env: c.env,
        title: `Account — ${c.env.SITE_NAME}`,
        description: 'Keep your Vestiq wardrobe across devices.',
        path: '/account',
        nonce: app.nonce,
        noindex: true,
        showHeaderSearch: true,
      },
      `<div class="wrap-narrow"><section class="section">
        <h1>Account</h1>
        ${
          user
            ? `<div class="notice good" style="margin-top:var(--s4)">Signed in as <strong>${esc(user.email)}</strong>.</div>
               <p class="muted">Your wardrobe, alerts, followed brands and saved searches now follow this account.</p>
               <p><a class="btn btn-primary" href="/wardrobe">Open wardrobe</a></p>
               <form method="POST" action="/account/logout" style="margin-top:var(--s4)"><button class="btn btn-sm" type="submit">Sign out</button></form>`
            : `<p class="muted" style="margin-top:var(--s3)">Use a one-time email link—no password. Anything saved in this browser will be merged into your account.</p>
               <form method="POST" action="/account/request" style="margin-top:var(--s5)">
                 <label class="field"><span>Email address</span><input type="email" name="email" required autocomplete="email"></label>
                 <button class="btn btn-primary" type="submit">Email me a sign-in link</button>
               </form>`
        }
      </section></div>`,
    ),
  );
});

pageRoutes.post('/account/request', async (c) => {
  const limited = await rateLimit(c.env, 'write', rateIdentity(c.req.raw, c.var.app.session.id));
  if (!limited.ok) return c.text('Too many requests. Try again later.', 429);
  if (!c.env.RESEND_API_KEY) {
    return c.html(
      layout(
        {
          env: c.env,
          title: `Email unavailable — ${c.env.SITE_NAME}`,
          description: 'Email sign-in is not configured.',
          path: '/account',
          nonce: c.var.app.nonce,
          noindex: true,
        },
        `<div class="wrap-narrow"><section class="section"><h1>Email isn’t configured yet.</h1><p class="muted">Your browser-bound wardrobe still works. The operator must configure Resend before cross-device sign-in can be used.</p></section></div>`,
      ),
      503,
    );
  }

  const form = await c.req.formData();
  const email = String(form.get('email') ?? '').trim().toLowerCase().slice(0, 200);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.text('Check the email address.', 400);

  const token = newId('', 48);
  const tokenHash = await sha256Hex(token);
  const tokenId = newId('at');
  await c.env.DB.prepare(
    `INSERT INTO ${T.authTokens} (id, email, token_hash, expires_at, created_at) VALUES (?,?,?,?,?)`,
  )
    .bind(tokenId, email, tokenHash, Date.now() + 20 * 60_000, Date.now())
    .run();

  try {
    await sendEmail(c.env, {
      to: email,
      from: 'Vestiq <hello@vestiq.in>',
      subject: 'Your Vestiq sign-in link',
      text: `Use this one-time link to sign in to Vestiq:\n\n${c.env.SITE_URL}/account/verify?token=${encodeURIComponent(token)}\n\nIt expires in 20 minutes. If you did not request it, ignore this email.`,
    });
  } catch (err) {
    await c.env.DB.prepare(`DELETE FROM ${T.authTokens} WHERE id = ?`).bind(tokenId).run();
    return c.text(`Could not send the sign-in email: ${String(err).slice(0, 80)}`, 502);
  }

  return c.html(
    layout(
      {
        env: c.env,
        title: `Check your email — ${c.env.SITE_NAME}`,
        description: 'Your sign-in link is on its way.',
        path: '/account',
        nonce: c.var.app.nonce,
        noindex: true,
      },
      `<div class="wrap-narrow"><section class="section"><h1>Check your email.</h1><p class="muted">We sent a one-time sign-in link to <strong>${esc(email)}</strong>. It expires in 20 minutes.</p></section></div>`,
    ),
  );
});

pageRoutes.get('/account/verify', async (c) => {
  const token = (c.req.query('token') ?? '').slice(0, 80);
  if (!/^[0-9a-z]{48}$/.test(token)) return c.text('Invalid or expired sign-in link.', 400);
  const tokenHash = await sha256Hex(token);
  const auth = await c.env.DB.prepare(
    `SELECT id, email FROM ${T.authTokens}
     WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
  )
    .bind(tokenHash, Date.now())
    .first<{ id: string; email: string }>();
  if (!auth) return c.text('Invalid or expired sign-in link.', 400);

  let user = await c.env.DB.prepare(`SELECT id, status FROM ${T.users} WHERE email = ?`)
    .bind(auth.email)
    .first<{ id: string; status: string }>();
  if (user && user.status !== 'active') return c.text('This account is unavailable.', 403);
  if (!user) {
    const id = newId('u');
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO ${T.users} (id, email, created_at, last_seen_at) VALUES (?,?,?,?)`,
    )
      .bind(id, auth.email, Date.now(), Date.now())
      .run();
    user = await c.env.DB.prepare(`SELECT id, status FROM ${T.users} WHERE email = ?`)
      .bind(auth.email)
      .first<{ id: string; status: string }>();
  }
  if (!user) return c.text('Could not create account.', 500);

  // Claim before merging. The conditional update makes the link truly one-use
  // even when two browser requests arrive at the same time.
  const claimed = await c.env.DB.prepare(
    `UPDATE ${T.authTokens} SET used_at = ?
     WHERE id = ? AND used_at IS NULL AND expires_at > ?`,
  )
    .bind(Date.now(), auth.id, Date.now())
    .run();
  if (!claimed.meta.changes) return c.text('Invalid or expired sign-in link.', 400);

  const anonymousOwner = ownerKey(c.var.app.session);
  const userOwner = `u:${user.id}`;
  await mergeOwner(c.env, anonymousOwner, userOwner);
  const shopperProfile = await loadShopperProfile(c.env, userOwner);
  await c.env.DB.prepare(`UPDATE ${T.users} SET last_seen_at = ? WHERE id = ?`)
    .bind(Date.now(), user.id)
    .run();
  c.var.app.session.user_id = user.id;
  if (shopperProfile) {
    c.var.app.session.fit = shopperProfile.fit;
    c.var.app.session.gender_pref = shopperProfile.fit.gender;
    c.var.app.session.taste = shopperProfile.taste;
  }
  await saveSession(c.env, c.var.app.session);
  return c.redirect('/wardrobe?signed_in=1', 303);
});

pageRoutes.post('/account/logout', async (c) => {
  delete c.var.app.session.user_id;
  await saveSession(c.env, c.var.app.session);
  return c.redirect('/account', 303);
});

// ============================================================ fit profile

pageRoutes.get('/profile', (c) => {
  const current = c.var.app.session.fit ?? { avoid_materials: [] };
  const sizes = ['xxs', 'xs', 's', 'm', 'l', 'xl', 'xxl', '3xl', '4xl', '5xl', 'free'];
  const shoeSizes = ['35', '36', '37', '38', '39', '40', '41', '42', '43', '44', '45', '46'];
  const option = (value: string, selected?: string) =>
    `<option value="${esc(value)}"${selected === value ? ' selected' : ''}>${esc(value.toUpperCase())}</option>`;
  return c.html(
    layout(
      {
        env: c.env,
        title: `Fit profile — ${c.env.SITE_NAME}`,
        description: 'Save your usual sizes and fit preferences for better-ranked fashion recommendations.',
        path: '/profile',
        nonce: c.var.app.nonce,
        noindex: true,
        showHeaderSearch: true,
      },
      `<div class="wrap-narrow"><section class="section page-intro">
        <p class="eyebrow">Personal fit</p><h1>Find your size sooner.</h1>
        <p class="muted">We lift products available in your usual size. Nothing is hidden because merchant sizing can be incomplete.</p>
        ${c.req.query('saved') === '1' ? '<div class="notice good">Fit profile saved. Search and outfit planning now use it.</div>' : ''}
        <form method="POST" action="/profile" class="profile-form">
          <div class="form-grid">
            <label class="field"><span>Shop for</span><select name="gender">
              <option value="">Any department</option>${['women', 'men', 'unisex', 'kids'].map((value) => `<option value="${value}"${current.gender === value ? ' selected' : ''}>${label(value)}</option>`).join('')}
            </select></label>
            <label class="field"><span>Preferred fit</span><select name="fit">
              <option value="">No preference</option>${['slim', 'regular', 'relaxed', 'oversized'].map((value) => `<option value="${value}"${current.fit === value ? ' selected' : ''}>${label(value)}</option>`).join('')}
            </select></label>
            <label class="field"><span>Usual top size</span><select name="top_size"><option value="">Not set</option>${sizes.map((value) => option(value, current.top_size)).join('')}</select></label>
            <label class="field"><span>Usual bottom size</span><select name="bottom_size"><option value="">Not set</option>${sizes.map((value) => option(value, current.bottom_size)).join('')}</select></label>
            <label class="field"><span>Shoe size</span><select name="shoe_size"><option value="">Not set</option>${shoeSizes.map((value) => option(value, current.shoe_size)).join('')}</select></label>
          </div>
          <fieldset class="preference-fieldset"><legend><h2>Materials to avoid</h2></legend>
            <p class="tiny">These are strongly demoted, not silently removed.</p>
            <div class="check-grid">${ALL_MATERIALS.slice(0, 18).map((material) => `<label class="check-card"><input type="checkbox" name="avoid_material" value="${esc(material)}"${current.avoid_materials.includes(material) ? ' checked' : ''}><span>${esc(label(material))}</span></label>`).join('')}</div>
          </fieldset>
          <button class="btn btn-primary" type="submit">Save fit profile</button>
        </form>
      </section></div>`,
    ),
  );
});

pageRoutes.post('/profile', async (c) => {
  const limited = await rateLimit(c.env, 'write', rateIdentity(c.req.raw, c.var.app.session.id));
  if (!limited.ok) return c.text('Too many requests. Try again later.', 429);
  const form = await c.req.formData();
  const profile = sanitiseFitProfile({
    gender: String(form.get('gender') ?? ''),
    fit: String(form.get('fit') ?? ''),
    top_size: String(form.get('top_size') ?? ''),
    bottom_size: String(form.get('bottom_size') ?? ''),
    shoe_size: String(form.get('shoe_size') ?? ''),
    avoid_materials: form.getAll('avoid_material').map(String),
  });
  c.var.app.session.fit = profile;
  c.var.app.session.gender_pref = profile.gender;
  await Promise.all([
    persistFitProfile(c.env, ownerKey(c.var.app.session), profile),
    saveSession(c.env, c.var.app.session),
  ]);
  return c.redirect('/profile?saved=1', 303);
});

// ============================================================ taste onboarding

pageRoutes.get('/taste', (c) => {
  const current = c.var.app.session.taste ?? {};
  const values = [
    ...ALL_STYLES.map((value) => ({ value, group: 'Style' })),
    ...ALL_MATERIALS.slice(0, 14).map((value) => ({ value, group: 'Fabric' })),
    ...ALL_COLORS.slice(0, 18).map((value) => ({ value, group: 'Colour' })),
  ];
  const groups = ['Style', 'Fabric', 'Colour']
    .map(
      (group) => `<fieldset style="margin-top:var(--s6)"><legend><h2>${group}</h2></legend>
        <div class="taste-grid">${values
          .filter((item) => item.group === group)
          .map(
            (item) => `<div class="taste-choice"><span>${esc(label(item.value))}</span>
              <label><input type="radio" name="taste:${esc(item.value)}" value="1"${current[item.value] > 0 ? ' checked' : ''}> Like</label>
              <label><input type="radio" name="taste:${esc(item.value)}" value="-1"${current[item.value] < 0 ? ' checked' : ''}> Avoid</label>
              <label><input type="radio" name="taste:${esc(item.value)}" value="0"${current[item.value] === undefined || current[item.value] === 0 ? ' checked' : ''}> Neutral</label>
            </div>`,
          )
          .join('')}</div></fieldset>`,
    )
    .join('');
  return c.html(
    layout(
      {
        env: c.env,
        title: `Your taste — ${c.env.SITE_NAME}`,
        description: 'Tune subtle preferences in Vestiq ranking.',
        path: '/taste',
        nonce: c.var.app.nonce,
        noindex: true,
        showHeaderSearch: true,
      },
      `<div class="wrap"><section class="section"><h1>Your taste</h1>
        <p class="muted">These preferences only break close ranking ties; they never hide otherwise relevant results.</p>
        <form method="POST" action="/taste">${groups}<button class="btn btn-primary" type="submit" style="margin-top:var(--s6)">Save preferences</button></form>
      </section></div>`,
    ),
  );
});

pageRoutes.post('/taste', async (c) => {
  const form = await c.req.formData();
  const allowed = new Set([...ALL_STYLES, ...ALL_MATERIALS, ...ALL_COLORS]);
  const taste: Record<string, number> = {};
  for (const [key, raw] of form.entries()) {
    if (!key.startsWith('taste:')) continue;
    const token = key.slice(6);
    if (!allowed.has(token)) continue;
    const value = Number(raw);
    if (value === 1 || value === -1) taste[token] = value;
  }
  c.var.app.session.taste = taste;
  await Promise.all([
    persistTasteProfile(c.env, ownerKey(c.var.app.session), taste),
    saveSession(c.env, c.var.app.session),
  ]);
  return c.redirect('/drops?taste=saved', 303);
});

// ============================================================ static pages

const STATIC_PAGES: Record<string, { title: string; description: string; body: string }> = {
  about: {
    title: 'About',
    description: 'Why Vestiq exists and how it works.',
    body: `<h1>About Vestiq</h1>
      <p>India has tens of thousands of independent fashion labels. Almost none of them
      are findable. Marketplaces rank by ad spend and inventory depth, so a brilliant
      40-piece label with no ad budget is invisible no matter how good it is.</p>
      <p>Meanwhile you already know what you want. You just can't say it in the language
      of a category tree. "Something for a beach wedding that isn't sweaty" is not a
      filter combination.</p>
      <p>Vestiq indexes the long tail for the way people actually describe clothes.
      Describe it however you think about it — a mood, an occasion, a budget, a
      screenshot — and we find it across brands you'd otherwise never see.</p>
      <h2>Free during launch</h2>
      <p>Vestiq is currently free for shoppers and brands. Search ordering is based
      on relevance and catalogue quality; there are no paid placements.</p>
      <h2>What we don't do</h2>
      <p>We don't take payments, hold inventory, or predict your size. You buy from the
      brand directly, on their own site, under their own returns policy.</p>`,
  },
  'for-brands': {
    title: 'For brands',
    description: 'Get discovered by shoppers already searching for what you make.',
    body: `<h1>For brands</h1>
      <p>Your customers are describing your product in a search box right now. They're
      just not finding you.</p>
      <h2>What you get</h2>
      <ul>
        <li><strong>Zero-effort listing.</strong> Paste your store URL. If you're on
        Shopify we derive the product feed automatically — no development work.</li>
        <li><strong>Demand data.</strong> See the exact queries that matched you, and
        the ones that <em>nearly</em> matched. That gap report is a product roadmap.</li>
        <li><strong>Feed health.</strong> Every rejected item, with the reason, so you
        can fix your data rather than guess.</li>
        <li><strong>Transparent attribution.</strong> Add approved referral parameters
        without changing your product host or buying placement.</li>
      </ul>
      <h2>What it costs</h2>
      <p>Nothing during launch. Listing, catalogue tools and discovery are free, with
      no subscription, payment setup or paid placement.</p>
      <p><a class="btn btn-primary" href="/merchant/signup">List your brand</a></p>`,
  },
  privacy: {
    title: 'Privacy',
    description: 'What we collect and why.',
    body: `<h1>Privacy</h1>
      <p><strong>Anonymous by default.</strong> You can search, save and set alerts.
      We set one first-party cookie holding a random session id. It contains no
      personal information. If you choose passwordless sign-in, we store your email
      and merge your wardrobe so it remains available across devices.</p>
      <h2>What we store</h2>
      <ul>
        <li>Your searches and which results you clicked, to improve ranking and to
        tell brands what people are looking for — in aggregate, never tied to you.</li>
        <li>Items you save, looks and trip wardrobes you build, brands you follow,
        fit and taste settings, and alerts you set, against your session or signed-in account.</li>
        <li>Your email address, only if you give it to us for alerts, saved-search
        digests or passwordless sign-in.</li>
      </ul>
      <h2>What we don't do</h2>
      <ul>
        <li>No third-party advertising or tracking pixels.</li>
        <li>We don't sell personal data.</li>
        <li>We don't pass your identity to brands. When you click out, the brand sees
        a referral. A disclosed affiliate link may include merchant-approved campaign
        parameters, never your profile or email.</li>
      </ul>
      <h2>Your controls</h2>
      <p>If you stay anonymous, clearing cookies detaches you from saved items. If
      you sign in, your wardrobe remains attached to your account so you can return
      on another device. To request deletion of data associated with your email,
      contact <a href="mailto:privacy@vestiq.in">privacy@vestiq.in</a> and we'll
      action it within 30 days.</p>`,
  },
  terms: {
    title: 'Terms',
    description: 'Terms of use.',
    body: `<h1>Terms</h1>
      <h2>What Vestiq is</h2>
      <p>Vestiq is a discovery and referral service. We are not the seller. Every
      purchase is a contract between you and the brand, governed by their terms,
      pricing and returns policy.</p>
      <h2>Accuracy</h2>
      <p>Prices, availability and descriptions come from brand-supplied feeds and are
      shown as last verified. They can change at any time. We show you when each
      listing was last checked; always confirm on the brand's own site before buying.</p>
      <h2>Free service</h2>
      <p>Vestiq is free during launch and does not sell paid search placement. Product
      links take you to the brand's own store.</p>
      <h2>Acceptable use</h2>
      <p>Don't scrape, resell our index, or attempt to overwhelm the service. We rate
      limit and may block abusive traffic.</p>
      <h2>Liability</h2>
      <p>The service is provided as-is. We are not liable for a brand's products,
      service, delivery or conduct.</p>
      <h2>Contact</h2>
      <p><a href="mailto:hello@vestiq.in">hello@vestiq.in</a></p>`,
  },
};

for (const [slug, page] of Object.entries(STATIC_PAGES)) {
  pageRoutes.get(`/${slug}`, (c) => {
    const { app } = c.var;
    return c.html(
      layout(
        {
          env: c.env,
          title: `${page.title} — ${c.env.SITE_NAME}`,
          description: page.description,
          path: `/${slug}`,
          nonce: app.nonce,
          showHeaderSearch: true,
        },
        `<div class="wrap-narrow"><section class="section">${page.body}</section></div>`,
      ),
    );
  });
}

// ============================================================ data helpers

interface LookSelection {
  slot: string;
  item: ResultItem;
}

interface LookSlot {
  slot: string;
  categories: string[];
  required: boolean;
}

const FOOTWEAR = new Set(['sneakers', 'heels', 'flats', 'sandals', 'boots']);
const ACCESSORIES = new Set([
  'bags',
  'clutches',
  'jewellery',
  'scarves',
  'belts',
  'sunglasses',
  'watches',
  'socks',
  'hats',
  'umbrellas',
]);
const TOPS = new Set(['tops', 'shirts', 'tshirts', 'kurtas', 'blouses', 'sweaters', 'sweatshirts']);
const BOTTOMS = new Set(['skirts', 'trousers', 'jeans', 'shorts']);

function outfitSlots(baseCategories: string[], hasSeed: boolean): LookSlot[] {
  // A generic "outfit" is better served by real separates than by guessing a
  // dress. This also lets fabric/occasion constraints shape both garments.
  if (!hasSeed && !baseCategories.length) return genericSeparatesSlots();
  const base = baseCategories[0] ?? 'dresses';
  if (hasSeed) {
    const complements = COMPLEMENTS[base] ?? ['heels', 'bags', 'jewellery'];
    const clothing = complements.filter((category) => !FOOTWEAR.has(category) && !ACCESSORIES.has(category));
    const footwear = complements.filter((category) => FOOTWEAR.has(category));
    const accessories = complements.filter((category) => ACCESSORIES.has(category));
    return [
      ...(clothing.length ? [{ slot: 'pairing piece', categories: clothing, required: false }] : []),
      { slot: 'footwear', categories: footwear.length ? footwear : ['heels', 'flats', 'sandals'], required: false },
      { slot: 'accessory', categories: accessories.length ? accessories : ['bags', 'clutches', 'jewellery'], required: false },
    ];
  }

  const slots: LookSlot[] = [{ slot: 'main piece', categories: baseCategories.length ? baseCategories : ['dresses', 'co-ord-sets', 'kurta-sets'], required: true }];
  if (TOPS.has(base)) {
    slots.push({ slot: 'bottom', categories: ['trousers', 'skirts', 'jeans'], required: true });
  } else if (BOTTOMS.has(base)) {
    slots.push({ slot: 'top', categories: ['tops', 'shirts', 'tshirts', 'kurtas'], required: true });
  }
  if (!FOOTWEAR.has(base)) {
    slots.push({ slot: 'footwear', categories: ['heels', 'flats', 'sandals', 'sneakers'], required: false });
  }
  if (!ACCESSORIES.has(base)) {
    slots.push({ slot: 'accessory', categories: ['bags', 'clutches', 'jewellery'], required: false });
  }
  return slots.slice(0, 4);
}

function genericSeparatesSlots(): LookSlot[] {
  return [
    { slot: 'top', categories: ['tops', 'shirts', 'tshirts', 'kurtas'], required: true },
    { slot: 'bottom', categories: ['trousers', 'skirts', 'jeans', 'shorts'], required: true },
    { slot: 'footwear', categories: ['heels', 'flats', 'sandals', 'sneakers'], required: false },
    { slot: 'accessory', categories: ['bags', 'clutches', 'jewellery'], required: false },
  ];
}

/**
 * Search each outfit slot, then evaluate the small Cartesian product to find a
 * coherent combination that stays under one total budget. This is a real total-
 * budget optimiser rather than four unrelated per-item price caps.
 */
async function buildBudgetedLook(
  env: Env,
  prompt: string,
  budget: number,
  session: AppContext['session'],
  seedId?: string,
  slotOverride?: LookSlot[],
): Promise<{ items: LookSelection[]; total: number }> {
  const { parseQueryCached } = await import('../search');
  const parse = await parseQueryCached(env, prompt, () => undefined);
  let seed: ResultItem | null = null;
  if (seedId) {
    const row = await env.DB.prepare(
      `SELECT ${PRODUCT_COLUMNS} FROM ${T.products} p JOIN ${T.brands} b ON b.id = p.brand_id
       WHERE p.id = ? AND p.status = 'active' AND p.availability != 'out_of_stock' AND b.status = 'active'`,
    )
      .bind(seedId)
      .first<Record<string, unknown>>();
    if (row) seed = toResultItem(row);
  }
  if (seed && seed.price > budget) return { items: [], total: 0 };

  const baseCategories = seed ? [seed.category] : parse.categories;
  const slots = slotOverride ?? outfitSlots(baseCategories, Boolean(seed));
  const candidateGroups: Array<{ slot: LookSlot; items: ResultItem[] }> = [];
  for (const slot of slots) {
    const stylingPiece = slot.slot === 'footwear' || slot.slot === 'accessory';
    const slotParse: ParsedQuery = {
      ...parse,
      semantic_text: `${parse.semantic_text || prompt}. ${slot.slot}: ${slot.categories.map(label).join(' or ')}`,
      categories: slot.categories,
      // "Breathable linen" describes the clothes, not the shoes or bag. Keep
      // the full prompt in semantic text so styling pieces still coordinate,
      // but do not make clothing-only fabrics a hard requirement for them.
      materials: stylingPiece ? [] : parse.materials,
      price_min: undefined,
      price_max: Math.min(parse.price_max ?? budget, budget - (seed?.price ?? 0)),
      // A reference brand is a style seed; an exact-brand constraint should not
      // force every part of a full look to come from the same small catalogue.
      brands: [],
    };
    const response = await search(env, {
      query: `${prompt} ${slot.categories.map(label).join(' ')}`,
      parse: slotParse,
      perPage: 10,
      session,
      filterMode: 'natural-language',
    });
    const items = response.items.filter((item) => item.id !== seed?.id && item.price <= budget).slice(0, 10);
    if (slot.required && !items.length) {
      // Generic outfit prompts frequently have no single-piece category. Try a
      // genuine separates outfit before declaring failure: a required top and
      // bottom, then optional footwear and an accessory.
      if (!seed && !slotOverride && !baseCategories.length) {
        return buildBudgetedLook(env, prompt, budget, session, undefined, genericSeparatesSlots());
      }
      return { items: [], total: 0 };
    }
    candidateGroups.push({ slot, items });
  }

  const fixed: LookSelection[] = seed ? [{ slot: 'foundation', item: seed }] : [];
  let best: LookSelection[] = [];
  let bestScore = -Infinity;
  const chosen = new Set(fixed.map((selection) => selection.item.id));

  const visit = (index: number, selections: LookSelection[], total: number, rankScore: number) => {
    if (total > budget) return;
    if (index === candidateGroups.length) {
      const all = [...fixed, ...selections];
      if (all.length < 2) return;
      const score = all.length * 2 + rankScore + total / Math.max(1, budget);
      if (score > bestScore) {
        bestScore = score;
        best = all;
      }
      return;
    }

    const group = candidateGroups[index];
    if (!group.slot.required) visit(index + 1, selections, total, rankScore);
    for (let rank = 0; rank < group.items.length; rank++) {
      const item = group.items[rank];
      if (chosen.has(item.id)) continue;
      const selectedGender = [...fixed, ...selections]
        .map((selection) => selection.item.gender)
        .find((gender) => gender !== 'unisex');
      if (item.gender !== 'unisex' && selectedGender && item.gender !== selectedGender) continue;
      chosen.add(item.id);
      selections.push({ slot: group.slot.slot, item });
      visit(index + 1, selections, total + item.price, rankScore + (group.items.length - rank) / group.items.length);
      selections.pop();
      chosen.delete(item.id);
    }
  };

  visit(0, [], seed?.price ?? 0, 0);
  if (!best.length && !seed && !slotOverride && !baseCategories.length) {
    return buildBudgetedLook(env, prompt, budget, session, undefined, genericSeparatesSlots());
  }
  return { items: best, total: best.reduce((sum, selection) => sum + selection.item.price, 0) };
}

interface TripPlanInput {
  destination: string;
  days: number;
  budget: number;
  occasions: string[];
  notes: string;
  session: AppContext['session'];
}

interface PlannedTripDay {
  day: number;
  label: string;
  prompt: string;
  budget: number;
  total: number;
  lookId: string;
  items: LookSelection[];
}

/** Build a capsule plan without ever spending more than the shared trip budget. */
async function buildTripPlan(
  env: Env,
  input: TripPlanInput,
): Promise<{ days: PlannedTripDay[]; total: number }> {
  const defaults = ['Arrival and exploring', 'Day out', 'Dinner', 'Relaxed day', 'Travel home'];
  const used = new Set<string>();
  const days: PlannedTripDay[] = [];
  let remaining = input.budget;

  for (let index = 0; index < input.days; index++) {
    const day = index + 1;
    const labelText = input.occasions[index % Math.max(1, input.occasions.length)] ?? defaults[index % defaults.length];
    const dayBudget = Math.floor(remaining / (input.days - index));
    const prompt = [
      `${labelText} in ${input.destination}`,
      'comfortable capsule piece that can be reworn',
      input.notes,
    ]
      .filter(Boolean)
      .join('. ')
      .slice(0, 300);

    let built = await buildBudgetedLook(env, prompt, dayBudget, input.session);
    let items = built.items.filter((selection) => !used.has(selection.item.id));
    let total = items.reduce((sum, selection) => sum + selection.item.price, 0);

    // Sparse catalogues may not have every complementary slot. A genuine,
    // available hero piece is more useful than inventing a complete outfit.
    if (!items.length) {
      const query = `${prompt} under ₹${Math.floor(dayBudget / 100)}`;
      const response = await search(env, {
        query,
        perPage: 24,
        session: input.session,
        filterMode: 'natural-language',
      });
      let pick = response.items.find((item) => item.price <= dayBudget && !used.has(item.id));
      if (!pick) {
        const broad = await env.DB.prepare(
          `SELECT ${PRODUCT_COLUMNS} FROM ${T.products} p
           JOIN ${T.brands} b ON b.id = p.brand_id
           WHERE p.status = 'active' AND p.availability != 'out_of_stock'
             AND b.status = 'active' AND p.price <= ?
           ORDER BY p.popularity DESC, p.last_verified_at DESC, p.price ASC LIMIT 60`,
        )
          .bind(dayBudget)
          .all<Record<string, unknown>>();
        const candidates = (broad.results ?? []).map(toResultItem).filter((item) => !used.has(item.id));
        const preferredSizes = [
          input.session.fit?.top_size,
          input.session.fit?.bottom_size,
          input.session.fit?.shoe_size,
        ].filter((value): value is string => Boolean(value));
        candidates.sort((a, b) => {
          const fitA = preferredSizes.some((size) => a.sizes.includes(size)) ? 1 : 0;
          const fitB = preferredSizes.some((size) => b.sizes.includes(size)) ? 1 : 0;
          const avoidA = a.materials.some((material) => input.session.fit?.avoid_materials.includes(material)) ? 1 : 0;
          const avoidB = b.materials.some((material) => input.session.fit?.avoid_materials.includes(material)) ? 1 : 0;
          return fitB - fitA || avoidA - avoidB || b.popularity - a.popularity || a.price - b.price;
        });
        pick = candidates[0];
      }
      if (!pick) break;
      items = [{ slot: 'hero piece', item: pick }];
      total = pick.price;
      built = { items, total };
    }

    if (total > dayBudget || total > remaining) break;
    for (const selection of items) used.add(selection.item.id);
    remaining -= total;
    days.push({
      day,
      label: truncate(labelText, 60),
      prompt,
      budget: dayBudget,
      total,
      lookId: newId('lk'),
      items,
    });
  }

  return { days, total: input.budget - remaining };
}

function toResultItem(row: Record<string, unknown>): ResultItem {
  return {
    ...rowToProduct(row),
    brand_name: String(row.brand_name),
    brand_slug: String(row.brand_slug),
    brand_trust: Number(row.brand_trust ?? 50),
    brand_ship_days:
      row.brand_ship_days === null || row.brand_ship_days === undefined
        ? null
        : Number(row.brand_ship_days),
    score: 0,
    match_reasons: [],
  };
}

/** Build homepage searches that are guaranteed to be backed by live items. */
export function inventorySearchExamples(items: ResultItem[], limit = 6): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (query: string) => {
    const clean = query.replace(/\s+/g, ' ').trim().slice(0, 80);
    const key = normaliseQuery(clean);
    if (!clean || seen.has(key) || out.length >= limit) return;
    seen.add(key);
    out.push(clean);
  };

  const count = (values: string[]) => {
    const counts = new Map<string, number>();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };

  // Broad, useful entry points first; exact titles fill the remaining slots.
  for (const [category] of count(items.map((item) => item.category))) add(label(category));
  for (const [brand] of count(items.map((item) => item.brand_name))) add(brand);
  for (const item of items) add(item.title);
  return out;
}

async function latestProducts(
  env: Env,
  limit: number,
  preferredBrandIds: string[] = [],
  session?: AppContext['session'],
): Promise<ResultItem[]> {
  const preferred = preferredBrandIds.slice(0, 50);
  const order = preferred.length
    ? `CASE WHEN p.brand_id IN (${inClause(preferred.length)}) THEN 0 ELSE 1 END, p.first_seen_at DESC`
    : 'p.first_seen_at DESC';
  const res = await env.DB.prepare(
    `SELECT ${PRODUCT_COLUMNS} FROM ${T.products} p JOIN ${T.brands} b ON b.id = p.brand_id
     WHERE p.status = 'active' AND p.availability != 'out_of_stock' AND b.status = 'active'
     ORDER BY ${order} LIMIT ?`,
  )
    .bind(...preferred, session?.taste ? Math.min(160, Math.max(limit, limit * 3)) : limit)
    .all<Record<string, unknown>>();
  const items = (res.results ?? []).map(toResultItem);
  if (session?.taste) {
    const { tasteFactor } = await import('../search/rank');
    const followed = new Set(preferred);
    items.sort((a, b) => {
      const followDelta = Number(followed.has(b.brand_id)) - Number(followed.has(a.brand_id));
      if (followDelta) return followDelta;
      const tasteDelta = tasteFactor(b, session) - tasteFactor(a, session);
      return tasteDelta || b.first_seen_at - a.first_seen_at;
    });
  }
  return items.slice(0, limit);
}

async function popularProducts(env: Env, limit: number): Promise<ResultItem[]> {
  const res = await env.DB.prepare(
    `SELECT ${PRODUCT_COLUMNS} FROM ${T.products} p JOIN ${T.brands} b ON b.id = p.brand_id
     WHERE p.status = 'active' AND p.availability != 'out_of_stock' AND b.status = 'active'
     ORDER BY p.popularity DESC, p.rating DESC LIMIT ?`,
  )
    .bind(limit)
    .all<Record<string, unknown>>();
  return (res.results ?? []).map(toResultItem);
}

async function latestBrands(env: Env, limit: number): Promise<Brand[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM ${T.brands} WHERE status = 'active' AND product_count > 0
     ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(limit)
    .all<Record<string, unknown>>();
  return (res.results ?? []).map(rowToBrand);
}

/** Same category, similar price band, different product. Cheap and effective. */
async function similarProducts(
  env: Env,
  product: { id: string; category: string; price: number; gender: string },
  limit: number,
): Promise<ResultItem[]> {
  const res = await env.DB.prepare(
    `SELECT ${PRODUCT_COLUMNS} FROM ${T.products} p JOIN ${T.brands} b ON b.id = p.brand_id
     WHERE p.status = 'active' AND p.availability != 'out_of_stock' AND b.status = 'active'
       AND p.category = ? AND p.id != ? AND (p.gender = ? OR p.gender = 'unisex')
       AND p.price BETWEEN ? AND ?
     ORDER BY ABS(p.price - ?) ASC, p.popularity DESC
     LIMIT ?`,
  )
    .bind(
      product.category,
      product.id,
      product.gender,
      Math.floor(product.price * 0.5),
      Math.ceil(product.price * 1.8),
      product.price,
      limit,
    )
    .all<Record<string, unknown>>();
  return (res.results ?? []).map(toResultItem);
}

async function priceHistoryFor(env: Env, productId: string): Promise<number[]> {
  try {
    const res = await env.DB.prepare(
      `SELECT price FROM ${T.priceHistory} WHERE product_id = ? ORDER BY ts ASC LIMIT 60`,
    )
      .bind(productId)
      .all<{ price: number }>();
    return (res.results ?? []).map((r) => r.price);
  } catch {
    return [];
  }
}
