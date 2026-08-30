import type { Availability, Gender } from '../types';
import { isPlaceholderHostname, slugify, unique } from '../lib/util';
import {
  CATEGORY_INDEX,
  COLOR_INDEX,
  GENDER_INDEX,
  MATERIAL_INDEX,
  OCCASION_INDEX,
  STYLE_INDEX,
  matchTokens,
} from '../ai/lexicon';

/**
 * Feed normalisation.
 *
 * Merchant feeds are wildly inconsistent — the same garment is "Kurta Set",
 * "kurta-set", "Ethnic Co-ord" and "SUIT SET" across four stores. Everything is
 * mapped onto the canonical lexicon here so that filters, facets and ranking see
 * one vocabulary.
 */

/** A feed row after adapter parsing, before normalisation. */
export interface RawItem {
  external_id: string;
  title: string;
  description?: string;
  category?: string;
  product_type?: string;
  tags?: string[];
  price_rupees?: number;
  mrp_rupees?: number;
  url: string;
  image_url?: string;
  images?: string[];
  colors?: string[];
  sizes?: string[];
  materials?: string[];
  availability?: string;
  gender?: string;
  vendor?: string;
}

export interface NormalisedItem {
  external_id: string;
  slug: string;
  title: string;
  description: string | null;
  category: string;
  subcategory: string | null;
  gender: Gender;
  price: number; // paise
  mrp: number | null; // paise
  url: string;
  image_url: string | null;
  images: string[];
  colors: string[];
  sizes: string[];
  materials: string[];
  occasions: string[];
  style_tags: string[];
  attributes: Record<string, unknown>;
  availability: Availability;
}

export type RejectReason =
  | 'missing_title'
  | 'missing_url'
  | 'bad_url'
  | 'placeholder_url'
  | 'missing_price'
  | 'implausible_price'
  | 'unmappable_category'
  | 'missing_image';

export type NormaliseResult =
  | { ok: true; item: NormalisedItem }
  | { ok: false; reason: RejectReason };

/** Prices outside this band are almost always a unit error in the feed. */
const MIN_PRICE_RUPEES = 49;
const MAX_PRICE_RUPEES = 5_000_000;

const SIZE_TOKEN = /^(xxs|xs|s|m|l|xl|xxl|3xl|4xl|5xl|free|onesize|\d{1,2}(\.\d)?)$/i;

function normaliseSizes(raw: string[]): string[] {
  const out: string[] = [];
  for (const value of raw) {
    const token = value.trim().toLowerCase().replace(/\s+/g, '');
    if (!token) continue;
    if (token === 'freesize' || token === 'onesize' || token === 'free') {
      out.push('free');
      continue;
    }
    // "UK 8" / "EU 39" / "Size M"
    const stripped = token.replace(/^(uk|us|eu|ind|size)/, '');
    if (SIZE_TOKEN.test(stripped)) out.push(stripped);
    else if (SIZE_TOKEN.test(token)) out.push(token);
  }
  return unique(out).slice(0, 24);
}

function normaliseAvailability(raw: string | undefined, hasStock: boolean): Availability {
  const v = (raw ?? '').toLowerCase();
  if (/out.?of.?stock|unavailable|sold.?out|oos|discontinued/.test(v)) return 'out_of_stock';
  if (/low|last few|limited|backorder|preorder/.test(v)) return 'low_stock';
  if (/in.?stock|available|yes|true|1/.test(v)) return 'in_stock';
  return hasStock ? 'in_stock' : 'out_of_stock';
}

function normaliseGender(raw: string | undefined, haystack: string): Gender {
  const explicit = (raw ?? '').toLowerCase();
  if (/wom|female|ladies|girl/.test(explicit)) return 'women';
  if (/\bmen\b|male|boy/.test(explicit)) return 'men';
  if (/kid|child|baby|infant|toddler/.test(explicit)) return 'kids';
  if (/unisex|neutral/.test(explicit)) return 'unisex';

  const matched = matchTokens(haystack, GENDER_INDEX);
  if (matched.length) return matched[0] as Gender;
  // Indian D2C fashion skews heavily womenswear; defaulting there beats
  // defaulting to 'unisex', which would leak menswear into women's results.
  return 'women';
}

export function normaliseItem(raw: RawItem): NormaliseResult {
  const title = (raw.title ?? '').trim();
  if (!title || title.length < 3) return { ok: false, reason: 'missing_title' };
  if (!raw.url) return { ok: false, reason: 'missing_url' };

  let url: string;
  try {
    const parsed = new URL(raw.url);
    if (parsed.protocol !== 'https:') return { ok: false, reason: 'bad_url' };
    if (isPlaceholderHostname(parsed.hostname)) return { ok: false, reason: 'placeholder_url' };
    url = parsed.toString();
  } catch {
    return { ok: false, reason: 'bad_url' };
  }

  if (raw.price_rupees === undefined || !Number.isFinite(raw.price_rupees)) {
    return { ok: false, reason: 'missing_price' };
  }
  if (raw.price_rupees < MIN_PRICE_RUPEES || raw.price_rupees > MAX_PRICE_RUPEES) {
    return { ok: false, reason: 'implausible_price' };
  }

  const images = unique(
    [raw.image_url, ...(raw.images ?? [])]
      .filter((v): v is string => typeof v === 'string' && /^https:\/\//i.test(v))
      .map((v) => v.trim()),
  ).slice(0, 8);
  if (!images.length) return { ok: false, reason: 'missing_image' };

  // Everything textual contributes to attribute inference.
  const haystack = [
    title,
    raw.description ?? '',
    raw.category ?? '',
    raw.product_type ?? '',
    ...(raw.tags ?? []),
    ...(raw.colors ?? []),
    ...(raw.materials ?? []),
  ]
    .join(' ')
    .toLowerCase();

  // Category: prefer the feed's own type field, fall back to the full text.
  const categoryCandidates = matchTokens(
    [raw.category, raw.product_type, ...(raw.tags ?? [])].filter(Boolean).join(' '),
    CATEGORY_INDEX,
  );
  const category = categoryCandidates[0] ?? matchTokens(haystack, CATEGORY_INDEX)[0];
  if (!category) return { ok: false, reason: 'unmappable_category' };

  const colors = unique([
    ...matchTokens((raw.colors ?? []).join(' '), COLOR_INDEX),
    ...matchTokens(title, COLOR_INDEX),
  ]).slice(0, 6);

  const materials = unique([
    ...matchTokens((raw.materials ?? []).join(' '), MATERIAL_INDEX),
    ...matchTokens(haystack, MATERIAL_INDEX),
  ]).slice(0, 6);

  const occasions = matchTokens(haystack, OCCASION_INDEX).slice(0, 6);
  const style_tags = matchTokens(haystack, STYLE_INDEX).slice(0, 8);

  const mrpRupees =
    raw.mrp_rupees !== undefined && Number.isFinite(raw.mrp_rupees) && raw.mrp_rupees > raw.price_rupees
      ? raw.mrp_rupees
      : null;

  const sizes = normaliseSizes(raw.sizes ?? []);

  return {
    ok: true,
    item: {
      external_id: String(raw.external_id).slice(0, 100),
      slug: slugify(title, 70),
      title: title.slice(0, 200),
      description: raw.description ? raw.description.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000) : null,
      category,
      subcategory: categoryCandidates[1] ?? null,
      gender: normaliseGender(raw.gender, haystack),
      price: Math.round(raw.price_rupees * 100),
      mrp: mrpRupees === null ? null : Math.round(mrpRupees * 100),
      url,
      image_url: images[0],
      images,
      colors,
      sizes,
      materials,
      occasions,
      style_tags,
      attributes: {},
      availability: normaliseAvailability(raw.availability, true),
    },
  };
}

/**
 * Content hash over the fields that matter to shoppers. An unchanged hash lets
 * ingestion skip the write entirely, which is what keeps us inside D1's free
 * write budget on a daily full-catalogue resync.
 */
export async function contentHash(item: NormalisedItem): Promise<string> {
  // Keep this list aligned with every NormalisedItem column persisted by the
  // upserter. In particular, a destination URL or secondary-image change must
  // not be mistaken for an unchanged product: both are directly shopper-facing.
  // Object keys are canonicalised so equivalent `attributes` objects hash the
  // same way regardless of insertion order.
  const material = stableJson({
    external_id: item.external_id,
    slug: item.slug,
    title: item.title,
    description: item.description,
    category: item.category,
    subcategory: item.subcategory,
    gender: item.gender,
    price: item.price,
    mrp: item.mrp,
    url: item.url,
    image_url: item.image_url,
    images: item.images,
    colors: item.colors,
    sizes: item.sizes,
    materials: item.materials,
    occasions: item.occasions,
    style_tags: item.style_tags,
    attributes: item.attributes,
    availability: item.availability,
  });
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return [...new Uint8Array(buf)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;

  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(',')}}`;
}

/** Text fed to the embedding model. Concrete and visual — see PARSE_SYSTEM_PROMPT. */
export function embedText(item: NormalisedItem, brandName: string): string {
  return [
    item.title,
    brandName,
    item.category.replace(/-/g, ' '),
    item.colors.join(' '),
    item.materials.join(' '),
    item.occasions.join(' '),
    item.style_tags.join(' ').replace(/-/g, ' '),
    item.description?.slice(0, 300) ?? '',
  ]
    .filter(Boolean)
    .join('. ')
    .slice(0, 1200);
}
