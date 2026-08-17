import { Hono } from 'hono';
import type { AppContext, Brand, Env, ParsedQuery, ResultItem, SortKey } from '../types';
import { PRODUCT_COLUMNS, T, inClause, rowToBrand, rowToProduct } from '../lib/db';
import { esc, formatINR, normaliseQuery, safeJson, sha256Hex, timeAgo, truncate } from '../lib/util';
import { ownerKey } from '../lib/session';
import { label } from '../ai/lexicon';
import { heuristicParse } from '../ai/heuristic';
import { search, trendingQueries } from '../search';
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
  const out: ParsedQuery = { ...parse };

  const categories = params.getAll('category').filter(Boolean);
  if (categories.length) out.categories = categories;

  const colors = params.getAll('color').filter(Boolean);
  if (colors.length) out.colors = colors;

  const materials = params.getAll('material').filter(Boolean);
  if (materials.length) out.materials = materials;

  const occasions = params.getAll('occasion').filter(Boolean);
  if (occasions.length) out.occasions = occasions;

  const sizes = params.getAll('size').filter(Boolean);
  if (sizes.length) out.sizes = sizes.map((s) => s.toLowerCase());

  const band = params.get('price_band');
  if (band) {
    const range = priceBandRange(band);
    if (range) {
      out.price_min = range.min > 0 ? range.min : undefined;
      out.price_max = range.max ?? undefined;
    }
  }

  const minRupees = parseInt(params.get('min') ?? '', 10);
  if (Number.isFinite(minRupees) && minRupees > 0) out.price_min = minRupees * 100;
  const maxRupees = parseInt(params.get('max') ?? '', 10);
  if (Number.isFinite(maxRupees) && maxRupees > 0) out.price_max = maxRupees * 100;

  // Chip removal (data-drop) arrives as ?drop=color:black
  for (const drop of params.getAll('drop')) {
    const [kind, value] = drop.split(':');
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

  const exampleQueries = [
    'matching co-ord set for a Goa vacation',
    'kitten heels under ₹4000',
    'quiet luxury but for 35°C',
    'what goes with wide-leg olive trousers',
    'something like Sabyasachi but under ₹6000',
    'beach wedding guest, not white',
  ];

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
  <h1>Fashion the internet hid from you.</h1>
  <p class="tagline">${esc(env.SITE_TAGLINE)} Search ${'10,000+'} independent brands by mood, occasion, budget — or a screenshot.</p>
  ${searchBarShell('hero')}
  <div class="examples">
    <ul class="chips">
      ${exampleQueries
        .map(
          (q) =>
            `<li><a class="chip" href="/search?q=${encodeURIComponent(q)}">${esc(q)}</a></li>`,
        )
        .join('')}
    </ul>
  </div>
</div></section>

<hr class="divider">

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
        description: `Describe what you want in plain words and find it across 10,000+ independent fashion brands. Search by mood, occasion, budget, or upload a photo.`,
        path: '/',
        nonce: app.nonce,
        jsonLd,
        showMobileDock: false,
      },
      body,
    ),
  );
});

// ============================================================ search

pageRoutes.get('/search', async (c) => {
  const { app } = c.var;
  const env = c.env;
  const url = new URL(c.req.url);
  const params = url.searchParams;
  const query = (params.get('q') ?? '').trim().slice(0, 300);

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
  const sortParam = params.get('sort') as SortKey | null;
  const sort: SortKey = sortParam && SORTS.includes(sortParam) ? sortParam : 'relevance';

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
  });

  const { recordSearch } = await import('../search');
  c.executionCtx.waitUntil(recordSearch(env, response, app.session));

  const queryHash = await sha256Hex(normaliseQuery(query));
  const saved = await savedIds(
    env,
    ownerKey(app.session),
    response.items.map((i) => i.id),
  );

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

  const relLinks = [
    page > 1
      ? `<link rel="prev" href="${esc(env.SITE_URL)}/search?q=${encodeURIComponent(query)}${page > 2 ? `&page=${page - 1}` : ''}">`
      : '',
    response.has_more
      ? `<link rel="next" href="${esc(env.SITE_URL)}/search?q=${encodeURIComponent(query)}&page=${page + 1}">`
      : '',
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
    </div>
    ${sortSelect(sort, query)}
  </div>
</div>

${
  response.total === 0
    ? emptyState(response)
    : `<div class="wrap">
      <div class="layout-with-rail">
        ${filterRail(response.facets, query, params)}
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
          ${pagination(page, response.has_more, canonicalPath)}
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
            b.return_days AS brand_return_days, b.city AS brand_city
     FROM ${T.products} p JOIN ${T.brands} b ON b.id = p.brand_id
     WHERE p.id = ? AND p.status != 'hidden'`,
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
    promoted: false,
  };

  // Canonical URL uses the current slug; redirect if the handle drifted, so we
  // never serve one product on two indexable URLs.
  const canonicalHandle = `${product.slug}-${product.id}`;
  if (handle !== canonicalHandle) return c.redirect(`/p/${canonicalHandle}`, 301);

  const [similar, priceHistory, saved] = await Promise.all([
    similarProducts(env, product, 10),
    priceHistoryFor(env, product.id),
    savedIds(env, ownerKey(app.session), [product.id]),
  ]);

  const images = product.images.length ? product.images : product.image_url ? [product.image_url] : [];
  const off = product.mrp && product.mrp > product.price;
  const inStock = product.availability !== 'out_of_stock';

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
         rel="nofollow sponsored noopener" target="_blank"
         style="margin-bottom:var(--s3)">
        View at ${esc(item.brand_name)} ${ICONS.arrow}
      </a>

      <div class="row" style="margin-bottom:var(--s5)">
        <button class="btn btn-sm" type="button" data-save="${esc(product.id)}"
          aria-pressed="${saved.has(product.id) ? 'true' : 'false'}">
          ${ICONS.heart} <span>${saved.has(product.id) ? 'Saved' : 'Save'}</span>
        </button>
        <button class="btn btn-sm" type="button" data-alert="${esc(product.id)}"
          data-kind="${inStock ? 'price_drop' : 'back_in_stock'}">
          ${ICONS.bell} <span>${inStock ? 'Alert on price drop' : 'Tell me when it’s back'}</span>
        </button>
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
        We may earn a commission if you buy through this link, at no extra cost to
        you. Price and availability shown as last checked and may differ at ${esc(item.brand_name)}.
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

  const response = await search(env, {
    query: brand.name,
    parse: { ...heuristicParse(''), semantic_text: '', confidence: 0.2 },
    brandId: brand.id,
    page,
    perPage: 24,
    sort: 'newest',
    session: app.session,
    noPromoted: true,
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
  const items = await latestProducts(env, 48);
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
        <p class="muted" style="margin:var(--s3) 0 var(--s6)">Freshest pieces we've indexed, newest first.</p>
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
    promoted: false,
  }));

  const alertsRes = await env.DB.prepare(
    `SELECT a.id, a.kind, a.target_price, a.base_price, a.status, p.title, p.slug, p.price, b.name AS brand_name
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
          <h1>Saved</h1>
          ${
            app.session.user_id
              ? ''
              : `<div class="notice" style="margin-top:var(--s4)">
                  These are saved to this browser. <a href="/account">Add your email</a> to
                  sync across devices and get alerts.
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
                      <td>${esc(truncate(String(a.title), 40))} <span class="tiny">${esc(String(a.brand_name))}</span></td>
                      <td>${a.kind === 'price_drop' ? 'Price drop' : 'Back in stock'}</td>
                      <td class="num">${esc(formatINR(Number(a.base_price)))}</td>
                      <td><span class="badge ${a.status === 'fired' ? 'good' : ''}">${esc(String(a.status))}</span></td>
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
              ${chipLinks(
                intents.map((i) => ({
                  label: `${i.query_raw} (${i.last_count})`,
                  href: `/search?q=${encodeURIComponent(i.query_raw)}`,
                })),
              )}
            </section>`
            : ''
        }
      </div>`,
    ),
  );
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
              Recommendations link to the brand's own store. We may earn a commission.
            </p>
          </form>
        </div>
      </div>`,
    ),
  );
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
      <h2>How we make money</h2>
      <p>When you buy through a link we may earn a commission from the brand, at no
      extra cost to you. Brands can also pay for clearly labelled <em>Promoted</em>
      placements, capped at two slots per page. Paid placement never changes the
      ranking of anything else — the ordering you see is the ordering our relevance
      model produced.</p>
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
        <li><strong>Optional promoted placement.</strong> Bid per click, cap your budget,
        pause anytime. Always labelled.</li>
      </ul>
      <h2>What it costs</h2>
      <p>Listing is free. We earn an affiliate commission on referred sales.
      Promoted placement is pay-per-click. Brand intelligence is a monthly
      subscription.</p>
      <p><a class="btn btn-primary" href="/merchant/signup">List your brand</a></p>`,
  },
  privacy: {
    title: 'Privacy',
    description: 'What we collect and why.',
    body: `<h1>Privacy</h1>
      <p><strong>Anonymous by default.</strong> You can search, save and set alerts
      without an account. We set one first-party cookie holding a random session id.
      It contains no personal information.</p>
      <h2>What we store</h2>
      <ul>
        <li>Your searches and which results you clicked, to improve ranking and to
        tell brands what people are looking for — in aggregate, never tied to you.</li>
        <li>Items you save and alerts you set, against your session id.</li>
        <li>Your email address, only if you give it to us for alerts.</li>
      </ul>
      <h2>What we don't do</h2>
      <ul>
        <li>No third-party advertising or tracking pixels.</li>
        <li>We don't sell personal data.</li>
        <li>We don't pass your identity to brands. When you click out, the brand sees
        a normal referral, the same as any link.</li>
      </ul>
      <h2>Your controls</h2>
      <p>Clearing cookies detaches you from your saved items. To delete an account and
      its data, email <a href="mailto:privacy@vestiq.in">privacy@vestiq.in</a> and we'll
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
      <h2>Commercial disclosure</h2>
      <p>We may earn commission on referred purchases. Some placements are paid and are
      labelled "Promoted". Paid placement does not alter organic ranking.</p>
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
    promoted: false,
  };
}

async function latestProducts(env: Env, limit: number): Promise<ResultItem[]> {
  const res = await env.DB.prepare(
    `SELECT ${PRODUCT_COLUMNS} FROM ${T.products} p JOIN ${T.brands} b ON b.id = p.brand_id
     WHERE p.status = 'active' AND p.availability != 'out_of_stock' AND b.status = 'active'
     ORDER BY p.first_seen_at DESC LIMIT ?`,
  )
    .bind(limit)
    .all<Record<string, unknown>>();
  return (res.results ?? []).map(toResultItem);
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
