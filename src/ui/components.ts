import type { Brand, Facets, ParsedQuery, Relaxation, ResultItem, SearchResponse } from '../types';
import { discountPct, esc, formatINR, timeAgo, truncate } from '../lib/util';
import { label } from '../ai/lexicon';
import { ICONS } from './layout';

/**
 * Pure HTML component functions. No client framework (ADR-1) — every one of
 * these returns a string and is directly unit-testable.
 *
 * Escaping rule: every interpolated value goes through `esc()`. Product and
 * brand text is merchant-supplied, i.e. untrusted.
 */

/**
 * Generated alt text. Never "product image" — screen-reader users deserve the
 * same information sighted users get from the photo (design §7).
 */
export function altFor(item: ResultItem): string {
  const bits = [item.brand_name, item.title];
  if (item.colors.length) bits.push(`in ${item.colors.slice(0, 2).map(label).join(' and ')}`);
  return bits.filter(Boolean).join(' ');
}

/**
 * Resize hotlinked merchant images through Cloudflare's image resizing so we
 * don't ship 2 MB originals into a 3:4 card (ADR-4). Falls back to the original
 * URL when the zone has no resizing available.
 */
export function imageUrl(src: string | null, width: number): string {
  if (!src) return '';
  if (!/^https?:\/\//i.test(src)) return '';
  return `/img?w=${width}&u=${encodeURIComponent(src)}`;
}

export function priceBlock(item: { price: number; mrp: number | null }, size = 'card'): string {
  const off = discountPct(item.price, item.mrp);
  const cls = size === 'pdp' ? 'pdp-price' : 'card-price';
  return `<div class="${cls}">
    <span class="now tnum">${esc(formatINR(item.price))}</span>
    ${off > 0 ? `<span class="was tnum">${esc(formatINR(item.mrp))}</span><span class="off">${off}% off</span>` : ''}
  </div>`;
}

/** Freshness + shipping trust signals (U19, U20). */
export function trustPill(item: ResultItem, now = Date.now()): string {
  const verifiedAge = item.last_verified_at ? now - item.last_verified_at : Infinity;
  const STALE = 7 * 86_400_000;

  if (verifiedAge > STALE) {
    return `<span class="trust-pill warn">${ICONS.alert} Last checked ${esc(timeAgo(item.last_verified_at, now))}</span>`;
  }
  if (item.brand_trust >= 70) {
    const ship = item.brand_ship_days ? ` · ships in ${item.brand_ship_days}d` : '';
    return `<span class="trust-pill good">${ICONS.check} Verified brand${esc(ship)}</span>`;
  }
  return `<span class="trust-pill">Checked ${esc(timeAgo(item.last_verified_at, now))}</span>`;
}

export function matchReasonChips(reasons: string[]): string {
  if (!reasons.length) return '';
  return `<ul class="chips card-reasons">${reasons
    .map((r) => `<li class="chip">${esc(r)}</li>`)
    .join('')}</ul>`;
}

export interface CardOptions {
  saved?: boolean;
  /** Rank position, for click attribution. */
  position?: number;
  queryHash?: string;
  eager?: boolean;
  now?: number;
}

/**
 * Product card. The whole card is one <a>; the save control is a nested
 * <button> (never a nested <a>, which is invalid HTML and breaks keyboard nav).
 * width/height are explicit so the grid never shifts as images load (CLS).
 */
export function productCard(item: ResultItem, opts: CardOptions = {}): string {
  const href = `/p/${esc(item.slug)}-${esc(item.id)}`;
  const img = imageUrl(item.image_url, 480);
  return `<article class="card"${opts.position !== undefined ? ` data-pos="${opts.position}"` : ''}>
  <button class="save-btn" type="button" data-save="${esc(item.id)}"
    aria-pressed="${opts.saved ? 'true' : 'false'}"
    aria-label="${opts.saved ? 'Remove from saved' : 'Save'} ${esc(item.title)}">${ICONS.heart}</button>
  <a href="${href}"${opts.queryHash ? ` data-q="${esc(opts.queryHash)}"` : ''}>
    <div class="card-media">
      ${
        img
          ? `<img src="${esc(img)}" alt="${esc(altFor(item))}" width="480" height="640"
             ${opts.eager ? 'data-eager loading="eager" fetchpriority="high"' : 'loading="lazy"'}
             decoding="async">`
          : ''
      }
    </div>
    <div class="card-brand">${esc(item.brand_name)}</div>
    <div class="card-title">${esc(truncate(item.title, 72))}</div>
    ${priceBlock(item)}
    ${trustPill(item, opts.now)}
  </a>
  ${matchReasonChips(item.match_reasons)}
</article>`;
}

export function productGrid(
  items: ResultItem[],
  opts: { savedIds?: Set<string>; queryHash?: string; startPos?: number; now?: number } = {},
): string {
  const start = opts.startPos ?? 0;
  return `<div class="grid">${items
    .map((item, i) =>
      productCard(item, {
        saved: opts.savedIds?.has(item.id),
        position: start + i,
        queryHash: opts.queryHash,
        eager: start + i < 4,
        now: opts.now,
      }),
    )
    .join('')}</div>`;
}

/**
 * ParseChips — the transparency device (design §5).
 *
 * Shows what the AI understood, with every chip individually removable. This is
 * what converts an opaque ranker into a correctable filter set.
 */
export function parseChips(parse: ParsedQuery, query: string): string {
  const chips: { label: string; drop: string }[] = [];

  for (const c of parse.categories) chips.push({ label: label(c), drop: `category:${c}` });
  for (const c of parse.colors) chips.push({ label: label(c), drop: `color:${c}` });
  for (const m of parse.materials) chips.push({ label: label(m), drop: `material:${m}` });
  for (const o of parse.occasions) chips.push({ label: label(o), drop: `occasion:${o}` });
  for (const s of parse.style_tags) chips.push({ label: label(s), drop: `style:${s}` });
  for (const c of parse.exclude_colors) chips.push({ label: `No ${label(c)}`, drop: `xcolor:${c}` });
  if (parse.price_max !== undefined)
    chips.push({ label: `≤ ${formatINR(parse.price_max)}`, drop: 'price_max' });
  if (parse.price_min !== undefined)
    chips.push({ label: `≥ ${formatINR(parse.price_min)}`, drop: 'price_min' });
  for (const s of parse.sizes) chips.push({ label: `Size ${s.toUpperCase()}`, drop: `size:${s}` });
  if (parse.gender) chips.push({ label: label(parse.gender), drop: 'gender' });
  for (const b of parse.brands) chips.push({ label: b, drop: `brand:${b}` });
  for (const b of parse.like_brands) chips.push({ label: `Like ${b}`, drop: `like:${b}` });

  if (!chips.length) return '';

  return `<div class="parsebar"><div class="wrap">
    <div class="row" style="flex-wrap:wrap">
      <span class="eyebrow">Understood as</span>
      <ul class="chips">
        ${chips
          .map(
            (c) => `<li class="chip chip-strong">${esc(c.label)}
          <button class="chip-remove" type="button" data-drop="${esc(c.drop)}"
            aria-label="Remove ${esc(c.label)} filter">&times;</button></li>`,
          )
          .join('')}
      </ul>
    </div>
  </div></div>`;
}

/** Contextual next moves after a search (U7). */
export function refineRail(parse: ParsedQuery, query: string): string {
  const refinements: string[] = [];
  if (parse.price_max === undefined) refinements.push('under ₹2000');
  else refinements.push('cheaper');
  if (!parse.materials.includes('cotton')) refinements.push('in cotton');
  if (!parse.materials.includes('linen')) refinements.push('in linen');
  if (!parse.style_tags.includes('oversized')) refinements.push('oversized');
  if (!parse.style_tags.includes('minimal')) refinements.push('more minimal');
  refinements.push('no print');

  return `<ul class="chips" style="margin-bottom:var(--s5)">
    <li class="eyebrow" style="align-self:center">Refine</li>
    ${refinements
      .slice(0, 6)
      .map(
        (r) =>
          `<li><a class="chip" href="/search?q=${encodeURIComponent(`${query} ${r}`)}">${esc(r)}</a></li>`,
      )
      .join('')}
  </ul>`;
}

/** Filter rail. Real form controls so it works with JS disabled (design §7). */
function hiddenSearchInputs(active: URLSearchParams, omit: Set<string>): string {
  return [...active.entries()]
    .filter(([key]) => !omit.has(key))
    .map(
      ([key, value]) =>
        `<input type="hidden" name="${esc(key)}" value="${esc(value)}">`,
    )
    .join('');
}

function comparableFacet(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function filterRail(
  facets: Facets,
  query: string,
  active: URLSearchParams,
  parse?: ParsedQuery,
): string {
  const inferred: Record<string, string[]> = {
    category: parse?.categories ?? [],
    color: parse?.colors ?? [],
    material: parse?.materials ?? [],
    occasion: parse?.occasions ?? [],
    size: parse?.sizes ?? [],
    brand: parse?.brands ?? [],
    price_band: [],
  };

  const group = (
    title: string,
    param: string,
    buckets: { value: string; label: string; count: number }[],
    single = false,
  ) => {
    if (!buckets.length) return '';
    const selected = new Set([...active.getAll(param), ...(inferred[param] ?? [])]);
    if (param === 'brand' && parse?.brands.length) {
      const wanted = new Set(parse.brands.map(comparableFacet));
      for (const bucket of buckets) {
        if (wanted.has(comparableFacet(bucket.value)) || wanted.has(comparableFacet(bucket.label))) {
          selected.add(bucket.value);
        }
      }
    }
    return `<section>
      <h3>${esc(title)}</h3>
      ${buckets
        .map(
          (b) => `<label>
        <input type="${single ? 'radio' : 'checkbox'}" name="${esc(param)}" value="${esc(b.value)}"${
          selected.has(b.value) ? ' checked' : ''
        }>
        <span>${esc(b.label)}</span><span class="count tnum">${b.count}</span>
      </label>`,
        )
        .join('')}
    </section>`;
  };

  const controlled = new Set([
    'q',
    'page',
    'format',
    'filters',
    'category',
    'price_band',
    'brand',
    'color',
    'material',
    'occasion',
    'size',
  ]);
  const form = () => `<form action="/search" method="GET">
      <input type="hidden" name="q" value="${esc(query)}">
      <input type="hidden" name="filters" value="1">
      ${hiddenSearchInputs(active, controlled)}
      ${group('Category', 'category', facets.category)}
      ${group('Price', 'price_band', facets.price_band, true)}
      ${group('Brand', 'brand', facets.brand)}
      ${group('Colour', 'color', facets.color)}
      ${group('Fabric', 'material', facets.material)}
      ${group('Occasion', 'occasion', facets.occasion)}
      ${group('Size', 'size', facets.size)}
      <button class="btn btn-block btn-sm" type="submit" style="margin-top:var(--s5)">Apply filters</button>
    </form>`;

  const activeCount = ['category', 'price_band', 'brand', 'color', 'material', 'occasion', 'size']
    .reduce((sum, key) => sum + active.getAll(key).length, 0);

  return `<div class="mobile-filters">
    <details>
      <summary class="btn btn-block">Filters${activeCount ? ` (${activeCount})` : ''}</summary>
      <div style="padding:var(--s4) 0">${form()}</div>
    </details>
  </div>
  <aside class="rail" aria-label="Search filters">${form()}</aside>`;
}

/**
 * Zero-result state. Never a dead end: it names the binding constraint and
 * offers one-tap relaxations (design §6).
 */
export function emptyState(response: SearchResponse): string {
  const relax = response.relaxations;
  return `<div class="empty wrap">
    <h2>Nothing matched that — yet.</h2>
    <p class="muted">${
      relax.length
        ? `We have plenty of similar pieces, but not with every constraint at once. Try loosening one:`
        : `We couldn't find anything for &ldquo;${esc(response.query)}&rdquo;. Our catalogue is growing weekly — try describing it differently.`
    }</p>
    ${
      relax.length
        ? `<ul class="chips">${relax
            .map(
              (r: Relaxation) =>
                `<li><a class="chip chip-strong" href="/search?q=${encodeURIComponent(r.query)}">${esc(r.label)}</a></li>`,
            )
            .join('')}</ul>`
        : ''
    }
    <p style="margin-top:var(--s6)">
      <a class="btn" href="/stylist?q=${encodeURIComponent(response.query)}">Ask the stylist instead ${ICONS.arrow}</a>
    </p>
  </div>`;
}

export function sortSelect(
  current: string,
  query: string,
  active: URLSearchParams = new URLSearchParams(),
): string {
  const options = [
    ['relevance', 'Most relevant'],
    ['newest', 'Newest'],
    ['price_asc', 'Price: low to high'],
    ['price_desc', 'Price: high to low'],
    ['popular', 'Most popular'],
  ];
  return `<form action="/search" method="GET" class="row">
    <input type="hidden" name="q" value="${esc(query)}">
    ${hiddenSearchInputs(active, new Set(['q', 'sort', 'page', 'format']))}
    <label class="sr-only" for="sort">Sort results</label>
    <select id="sort" name="sort" data-autosubmit>
      ${options
        .map(
          ([v, l]) =>
            `<option value="${v}"${current === v ? ' selected' : ''}>${esc(l)}</option>`,
        )
        .join('')}
    </select>
    <noscript><button class="btn btn-sm" type="submit">Sort</button></noscript>
  </form>`;
}

/**
 * Real <a href> pagination. Infinite scroll is layered on top by the client
 * island; these links remain for crawlers and JS-off users (design §7).
 */
export function pagination(page: number, hasMore: boolean, baseUrl: string): string {
  const link = (p: number, text: string, rel?: string) => {
    const url = new URL(baseUrl, 'https://x');
    url.searchParams.set('page', String(p));
    return `<a class="btn" href="${esc(url.pathname + url.search)}"${rel ? ` rel="${rel}"` : ''}>${esc(text)}</a>`;
  };
  if (page === 1 && !hasMore) return '';
  return `<nav class="pagination" aria-label="Pagination">
    ${page > 1 ? link(page - 1, '← Previous', 'prev') : ''}
    <span class="chip">Page ${page}</span>
    ${hasMore ? link(page + 1, 'Next →', 'next') : ''}
  </nav>`;
}

export function sectionHead(title: string, href?: string, linkText = 'See all'): string {
  return `<div class="section-head">
    <h2>${esc(title)}</h2>
    ${href ? `<a href="${esc(href)}">${esc(linkText)} →</a>` : ''}
  </div>`;
}

export function brandCard(brand: Brand): string {
  return `<article class="card">
    <a href="/brand/${esc(brand.slug)}">
      <div class="card-media" style="aspect-ratio:4/3;display:grid;place-items:center">
        ${
          brand.logo_url
            ? `<img src="${esc(imageUrl(brand.logo_url, 320))}" alt="${esc(brand.name)} logo" width="320" height="240" loading="lazy" decoding="async" style="object-fit:contain;padding:var(--s5)">`
            : `<span style="font-family:var(--serif);font-size:1.5rem">${esc(brand.name)}</span>`
        }
      </div>
      <div class="card-title" style="font-size:var(--t-h3);font-weight:600">${esc(brand.name)}</div>
      <div class="tiny">${esc(
        [brand.city, `${brand.product_count} pieces`].filter(Boolean).join(' · '),
      )}</div>
    </a>
  </article>`;
}

export function chipLinks(items: { label: string; href: string }[]): string {
  if (!items.length) return '';
  return `<ul class="chips">${items
    .map((i) => `<li><a class="chip" href="${esc(i.href)}">${esc(i.label)}</a></li>`)
    .join('')}</ul>`;
}

/** Price history sparkline for the wardrobe (U13/U14). Pure SVG, no JS. */
export function sparkline(points: number[]): string {
  if (points.length < 2) return '';
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const w = 100;
  const h = 32;
  const path = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * w;
      const y = h - ((p - min) / range) * (h - 4) - 2;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const trendDown = points[points.length - 1] < points[0];
  return `<svg class="sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img"
    aria-label="Price ${trendDown ? 'fell' : 'rose'} from ${formatINR(points[0])} to ${formatINR(points[points.length - 1])}">
    <path d="${path}" fill="none" stroke="${trendDown ? 'var(--good)' : 'var(--ink-3)'}" stroke-width="1.5"/>
  </svg>`;
}
