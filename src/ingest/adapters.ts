import type { RawItem } from './normalize';

/**
 * Feed adapters. One interface, one file per format — adding a new format is a
 * single function (docs/03-architecture.md §6).
 *
 * Every fetch goes through `safeFetch`, which is the SSRF boundary: merchants
 * supply these URLs, so they are hostile input.
 */

export type FeedType = 'shopify' | 'gmc' | 'csv';

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 20_000;

/**
 * Public Shopify feeds expose at most 250 products per page. Keep catalogue
 * ingestion deliberately bounded: the final request is an empty-page probe so
 * a catalogue of exactly 5,000 products is accepted, while a larger catalogue
 * fails as a whole instead of being silently truncated (which would make the
 * upserter mark unseen products out of stock).
 */
export const SHOPIFY_PAGE_SIZE = 250;
export const SHOPIFY_MAX_ITEMS = 5_000;
export const SHOPIFY_MAX_PAGE_REQUESTS = Math.ceil(SHOPIFY_MAX_ITEMS / SHOPIFY_PAGE_SIZE) + 1;
export const SHOPIFY_MAX_BYTES = 32 * 1024 * 1024;

/** Hostnames that must never be fetched, even though Workers can't reach most. */
const BLOCKED_HOST = /^(localhost|.*\.local|.*\.internal|metadata\..*|169\.254\..*|10\..*|127\..*|192\.168\..*|172\.(1[6-9]|2\d|3[01])\..*|\[?::1\]?|0\.0\.0\.0)$/i;

export function assertSafeUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'https:') throw new Error('feed URL must be https');
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOST.test(host)) throw new Error('feed host not permitted');
  // Bare IP literals are never legitimate storefronts.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) throw new Error('IP literals not permitted');
  return url;
}

interface SafeFetchResult {
  body: string;
  bytes: number;
}

async function safeFetchResult(raw: string): Promise<SafeFetchResult> {
  let current = assertSafeUrl(raw);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(current.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept: 'application/json, text/csv, application/xml, text/xml, */*',
          'user-agent': 'VestiqBot/1.0 (+https://vestiq.in/for-brands)',
        },
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) throw new Error(`redirect with no location (${res.status})`);
        // Re-validate every hop — a redirect into a private address is the classic
        // SSRF bypass.
        current = assertSafeUrl(new URL(location, current).toString());
        continue;
      }

      if (!res.ok) throw new Error(`feed fetch failed: ${res.status}`);

      const declared = parseInt(res.headers.get('content-length') ?? '0', 10);
      if (declared > MAX_BODY_BYTES) throw new Error('feed too large');

      // Enforce the cap even when content-length is absent or lies. Keep the
      // abort timer active while consuming the body too; fetch() resolving does
      // not mean a hostile server has finished sending it.
      const buf = await readCapped(res, MAX_BODY_BYTES);
      return { body: new TextDecoder().decode(buf), bytes: buf.byteLength };
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error('too many redirects');
}

export async function safeFetch(raw: string): Promise<string> {
  return (await safeFetchResult(raw)).body;
}

async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new Error('feed too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------- shopify

interface ShopifyVariant {
  id?: number | string;
  price?: string;
  compare_at_price?: string | null;
  available?: boolean;
  option1?: string | null;
  option2?: string | null;
  option3?: string | null;
}

interface ShopifyProduct {
  id?: number | string;
  handle?: string;
  title?: string;
  body_html?: string;
  product_type?: string;
  tags?: string[] | string;
  vendor?: string;
  variants?: ShopifyVariant[];
  images?: { src?: string }[];
  options?: { name?: string; values?: string[] }[];
}

function shopifyProducts(body: string): ShopifyProduct[] {
  const data = JSON.parse(body) as { products?: unknown };
  if (!Array.isArray(data?.products)) return [];
  return data.products.filter(
    (product): product is ShopifyProduct => Boolean(product) && typeof product === 'object',
  );
}

/** Shopify's public `/products.json`. Paginated 250 at a time. */
export function parseShopify(body: string, storeOrigin: string): RawItem[] {
  return parseShopifyProducts(shopifyProducts(body), storeOrigin);
}

function parseShopifyProducts(products: ShopifyProduct[], storeOrigin: string): RawItem[] {
  const out: RawItem[] = [];

  for (const p of products) {
    const variants = p.variants ?? [];
    const prices = variants
      .map((v) => parseFloat(v.price ?? ''))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (!prices.length) continue;

    const price = Math.min(...prices);
    const compares = variants
      .map((v) => parseFloat(v.compare_at_price ?? ''))
      .filter((n) => Number.isFinite(n) && n > 0);
    const mrp = compares.length ? Math.max(...compares) : undefined;

    // Size lives in whichever option is named "size"; fall back to option1.
    const sizeOptionIndex = (p.options ?? []).findIndex((o) => /size/i.test(o.name ?? ''));
    const sizes =
      sizeOptionIndex >= 0
        ? (p.options?.[sizeOptionIndex]?.values ?? [])
        : variants.map((v) => v.option1 ?? '').filter(Boolean);

    const colorOptionIndex = (p.options ?? []).findIndex((o) => /colou?r/i.test(o.name ?? ''));
    const colors = colorOptionIndex >= 0 ? (p.options?.[colorOptionIndex]?.values ?? []) : [];

    const tags = Array.isArray(p.tags)
      ? p.tags
      : typeof p.tags === 'string'
        ? p.tags.split(',').map((t) => t.trim())
        : [];

    out.push({
      external_id: String(p.id ?? p.handle ?? ''),
      title: p.title ?? '',
      description: p.body_html ?? undefined,
      product_type: p.product_type ?? undefined,
      tags,
      price_rupees: price,
      mrp_rupees: mrp,
      url: `${storeOrigin.replace(/\/$/, '')}/products/${p.handle ?? ''}`,
      image_url: p.images?.[0]?.src,
      images: (p.images ?? []).map((i) => i.src ?? '').filter(Boolean),
      colors,
      sizes,
      availability: variants.some((v) => v.available) ? 'in_stock' : 'out_of_stock',
      vendor: p.vendor,
    });
  }

  return out;
}

async function fetchShopifyFeed(feedUrl: string): Promise<{ items: RawItem[]; bytes: number }> {
  const feed = assertSafeUrl(feedUrl);
  const items: RawItem[] = [];
  let bytes = 0;
  let productsSeen = 0;

  for (let page = 1; page <= SHOPIFY_MAX_PAGE_REQUESTS; page++) {
    const pageUrl = new URL(feed);
    pageUrl.searchParams.set('limit', String(SHOPIFY_PAGE_SIZE));
    pageUrl.searchParams.set('page', String(page));

    const fetched = await safeFetchResult(pageUrl.toString());
    bytes += fetched.bytes;
    if (bytes > SHOPIFY_MAX_BYTES) throw new Error('Shopify feed exceeds aggregate byte limit');

    const products = shopifyProducts(fetched.body);
    if (products.length > SHOPIFY_PAGE_SIZE) {
      throw new Error('Shopify feed page exceeds item limit');
    }
    if (productsSeen + products.length > SHOPIFY_MAX_ITEMS) {
      throw new Error('Shopify feed exceeds item limit');
    }

    items.push(...parseShopifyProducts(products, feed.origin));
    productsSeen += products.length;

    if (products.length < SHOPIFY_PAGE_SIZE) return { items, bytes };
  }

  // The loop can only exhaust when the empty-page probe itself returned a full
  // page. Refuse the partial catalogue rather than delisting unseen products.
  throw new Error('Shopify feed exceeds page limit');
}

// ---------------------------------------------------------------- google merchant

/** Minimal XML value extractor. A full parser is unnecessary for GMC's flat items. */
function xmlValue(block: string, tag: string): string | undefined {
  const re = new RegExp(`<(?:g:)?${tag}[^>]*>([\\s\\S]*?)</(?:g:)?${tag}>`, 'i');
  const m = re.exec(block);
  if (!m) return undefined;
  return decodeXmlEntities(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim();
}

function xmlValues(block: string, tag: string): string[] {
  const re = new RegExp(`<(?:g:)?${tag}[^>]*>([\\s\\S]*?)</(?:g:)?${tag}>`, 'gi');
  const out: string[] = [];
  for (const m of block.matchAll(re)) {
    out.push(decodeXmlEntities(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim());
  }
  return out;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

/** "1299.00 INR" / "₹1299" / "1299" → 1299 */
function parseMoney(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = /([\d,]+(?:\.\d+)?)/.exec(raw.replace(/\s/g, ''));
  if (!m) return undefined;
  const n = parseFloat(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

export function parseGoogleMerchant(body: string): RawItem[] {
  const out: RawItem[] = [];
  for (const m of body.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/gi)) {
    const block = m[1];
    const link = xmlValue(block, 'link');
    const price = parseMoney(xmlValue(block, 'price'));
    if (!link || price === undefined) continue;

    out.push({
      external_id: xmlValue(block, 'id') ?? link,
      title: xmlValue(block, 'title') ?? '',
      description: xmlValue(block, 'description'),
      category: xmlValue(block, 'product_type') ?? xmlValue(block, 'google_product_category'),
      price_rupees: parseMoney(xmlValue(block, 'sale_price')) ?? price,
      mrp_rupees: xmlValue(block, 'sale_price') ? price : undefined,
      url: link,
      image_url: xmlValue(block, 'image_link'),
      images: [
        xmlValue(block, 'image_link'),
        ...xmlValues(block, 'additional_image_link'),
      ].filter((v): v is string => Boolean(v)),
      colors: (xmlValue(block, 'color') ?? '').split('/').filter(Boolean),
      sizes: xmlValues(block, 'size'),
      materials: (xmlValue(block, 'material') ?? '').split('/').filter(Boolean),
      availability: xmlValue(block, 'availability'),
      gender: xmlValue(block, 'gender'),
      vendor: xmlValue(block, 'brand'),
    });
  }
  return out;
}

// ---------------------------------------------------------------- csv

/** RFC4180-ish CSV parser: handles quoted fields, embedded commas, and CRLF. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\r') {
      // handled by the \n branch
    } else {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

const SPLIT_MULTI = /[|;]/;

export function parseCsv(body: string): RawItem[] {
  const rows = parseCsvRows(body);
  if (rows.length < 2) return [];

  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const idx = (name: string) => header.indexOf(name);
  const col = (row: string[], name: string): string | undefined => {
    const i = idx(name);
    if (i < 0) return undefined;
    const v = row[i]?.trim();
    return v ? v : undefined;
  };

  const out: RawItem[] = [];
  for (const row of rows.slice(1)) {
    const url = col(row, 'url') ?? col(row, 'link');
    const priceRaw = col(row, 'price');
    if (!url || !priceRaw) continue;
    const price = parseMoney(priceRaw);
    if (price === undefined) continue;

    out.push({
      external_id: col(row, 'id') ?? col(row, 'sku') ?? url,
      title: col(row, 'title') ?? col(row, 'name') ?? '',
      description: col(row, 'description'),
      category: col(row, 'category') ?? col(row, 'product_type'),
      price_rupees: price,
      mrp_rupees: parseMoney(col(row, 'mrp') ?? col(row, 'compare_at_price')),
      url,
      image_url: col(row, 'image_url') ?? col(row, 'image'),
      images: (col(row, 'images') ?? '').split(SPLIT_MULTI).map((s) => s.trim()).filter(Boolean),
      colors: (col(row, 'colors') ?? col(row, 'color') ?? '').split(SPLIT_MULTI).map((s) => s.trim()).filter(Boolean),
      sizes: (col(row, 'sizes') ?? col(row, 'size') ?? '').split(SPLIT_MULTI).map((s) => s.trim()).filter(Boolean),
      materials: (col(row, 'materials') ?? col(row, 'material') ?? '').split(SPLIT_MULTI).map((s) => s.trim()).filter(Boolean),
      availability: col(row, 'availability') ?? col(row, 'stock'),
      gender: col(row, 'gender'),
      vendor: col(row, 'brand') ?? col(row, 'vendor'),
    });
  }
  return out;
}

// ---------------------------------------------------------------- dispatch

export async function fetchFeed(
  feedUrl: string,
  feedType: FeedType,
): Promise<{ items: RawItem[]; bytes: number }> {
  if (feedType === 'shopify') return fetchShopifyFeed(feedUrl);

  const fetched = await safeFetchResult(feedUrl);
  const body = fetched.body;

  let items: RawItem[];
  switch (feedType) {
    case 'gmc':
      items = parseGoogleMerchant(body);
      break;
    case 'csv':
      items = parseCsv(body);
      break;
    default:
      throw new Error(`unknown feed type: ${feedType}`);
  }

  return { items, bytes: fetched.bytes };
}
