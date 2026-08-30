import type { ParsedQuery, Product, Relaxation, SessionData } from '../types';
import { formatINR, unique } from '../lib/util';
import { label } from '../ai/lexicon';
import type { LexicalHit } from './lexical';
import type { VectorHit } from './vector';

/**
 * Fusion, filtering and ranking.
 *
 * Split into pure functions with no I/O so ranking behaviour is directly
 * testable without database or network I/O.
 */

/** Reciprocal Rank Fusion constant. 60 is the value from the original TREC work
 *  and needs no per-corpus tuning, which matters with zero relevance labels. */
const RRF_K = 60;

export interface FusionArm {
  name: string;
  hits: { id: string; score: number }[];
  /** Relative trust in this arm. */
  weight: number;
}

export interface FusedHit {
  id: string;
  score: number;
  arms: string[];
}

/**
 * Reciprocal Rank Fusion. Uses each arm's *rank*, not its raw score, so we never
 * have to normalise BM25 against cosine — the two are not comparable and any
 * attempt to scale them is a tuning liability.
 */
export function fuse(arms: FusionArm[]): FusedHit[] {
  const acc = new Map<string, { score: number; arms: string[] }>();

  for (const arm of arms) {
    // Defensive: an arm may arrive unsorted.
    const sorted = [...arm.hits].sort((a, b) => b.score - a.score);
    for (let i = 0; i < sorted.length; i++) {
      const contribution = arm.weight / (RRF_K + i + 1);
      const existing = acc.get(sorted[i].id);
      if (existing) {
        existing.score += contribution;
        if (!existing.arms.includes(arm.name)) existing.arms.push(arm.name);
      } else {
        acc.set(sorted[i].id, { score: contribution, arms: [arm.name] });
      }
    }
  }

  return [...acc.entries()]
    .map(([id, v]) => ({ id, score: v.score, arms: v.arms }))
    .sort((a, b) => b.score - a.score);
}

export function toArms(
  lexical: LexicalHit[],
  vector: VectorHit[] | null,
  structured: LexicalHit[],
  parse: ParsedQuery,
): FusionArm[] {
  const arms: FusionArm[] = [];

  // Low parser confidence means the structured fields are unreliable, so lean
  // harder on semantic similarity; high confidence favours lexical precision.
  const semanticWeight = parse.confidence < 0.5 ? 1.3 : 1.0;

  if (lexical.length) arms.push({ name: 'lexical', hits: lexical, weight: 1.0 });
  if (vector?.length) {
    arms.push({
      name: 'semantic',
      hits: vector.map((h) => ({ id: h.id, score: h.similarity })),
      weight: semanticWeight,
    });
  }
  // Structured is a safety net, not a ranking signal — hence the low weight.
  if (structured.length) arms.push({ name: 'structured', hits: structured, weight: 0.45 });

  return arms;
}

// ---------------------------------------------------------------- hard filters

export interface FilterOutcome {
  kept: Product[];
  /** Which constraint eliminated the most candidates — powers the empty state. */
  binding: string | null;
  removedBy: Record<string, number>;
}

type FilterableProduct = Product & {
  brand_name?: string;
  brand_slug?: string;
};

/** Brand filters arrive either as parser-provided names or URL-stable slugs/ids. */
function brandKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Hard constraints, applied after recall.
 *
 * Applied post-recall (not in SQL) so that we can report *which* constraint was
 * binding when the result set collapses — that report is what makes the zero-
 * result state actionable instead of a dead end (U-design §6).
 */
export function applyFilters<T extends FilterableProduct>(
  products: T[],
  parse: ParsedQuery,
): FilterOutcome & { kept: T[] } {
  const removedBy: Record<string, number> = {};
  const bump = (k: string) => {
    removedBy[k] = (removedBy[k] ?? 0) + 1;
  };

  const kept = products.filter((p) => {
    // Every recall arm must converge on the same shopper-visible inventory.
    // Lexical and structured SQL already apply this gate; keeping it here also
    // protects semantic/vector candidates and future recall implementations.
    if (p.availability === 'out_of_stock') {
      bump('availability');
      return false;
    }
    if (parse.price_max !== undefined && p.price > parse.price_max) {
      bump('price_max');
      return false;
    }
    if (parse.price_min !== undefined && p.price < parse.price_min) {
      bump('price_min');
      return false;
    }
    if (parse.gender && p.gender !== parse.gender && p.gender !== 'unisex') {
      bump('gender');
      return false;
    }
    if (parse.categories.length && !parse.categories.includes(p.category)) {
      bump('categories');
      return false;
    }
    if (parse.colors.length && !parse.colors.some((color) => p.colors.includes(color))) {
      bump('colors');
      return false;
    }
    if (
      parse.materials.length &&
      !parse.materials.some((material) => p.materials.includes(material))
    ) {
      bump('materials');
      return false;
    }
    if (
      parse.occasions.length &&
      !parse.occasions.some((occasion) => p.occasions.includes(occasion))
    ) {
      bump('occasions');
      return false;
    }
    if (
      parse.style_tags.length &&
      !parse.style_tags.some((style) => p.style_tags.includes(style))
    ) {
      bump('style_tags');
      return false;
    }
    if (parse.brands.length) {
      const productBrands = new Set(
        [p.brand_id, p.brand_slug ?? '', p.brand_name ?? ''].map(brandKey).filter(Boolean),
      );
      if (!parse.brands.some((brand) => productBrands.has(brandKey(brand)))) {
        bump('brands');
        return false;
      }
    }
    if (parse.exclude_colors.length && p.colors.some((c) => parse.exclude_colors.includes(c))) {
      bump('exclude_colors');
      return false;
    }
    if (parse.sizes.length) {
      const wanted = parse.sizes.map((s) => s.toLowerCase());
      if (!p.sizes.some((s) => wanted.includes(s.toLowerCase()))) {
        bump('sizes');
        return false;
      }
    }
    if (parse.exclude_terms.length) {
      const haystack = `${p.title} ${p.description ?? ''} ${p.style_tags.join(' ')}`.toLowerCase();
      if (parse.exclude_terms.some((t) => t.length > 2 && haystack.includes(t.toLowerCase()))) {
        bump('exclude_terms');
        return false;
      }
    }
    return true;
  });

  const binding =
    Object.entries(removedBy).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return { kept, binding, removedBy };
}

// ---------------------------------------------------------------- scoring

const DAY = 86_400_000;

/** Freshness multiplier. A listing we haven't verified recently is a trust risk,
 *  so it is demoted rather than hidden — hiding would collapse a young catalog. */
export function freshnessFactor(lastVerifiedAt: number | null, now: number): number {
  if (!lastVerifiedAt) return 0.8;
  const age = now - lastVerifiedAt;
  if (age <= 7 * DAY) return 1.0;
  if (age <= 21 * DAY) return 0.9;
  return 0.72;
}

export function trustFactor(brandTrust: number): number {
  // 0..100 → 0.85..1.15. Bounded so trust can reorder near-ties without ever
  // letting a high-trust brand bury a much better match.
  return 0.85 + (Math.max(0, Math.min(100, brandTrust)) / 100) * 0.3;
}

export function popularityFactor(popularity: number): number {
  return 1 + Math.min(0.15, Math.log1p(Math.max(0, popularity)) / 40);
}

/**
 * Taste bias from onboarding (U17) and click history, expressed over style tags
 * rather than vectors so it costs nothing at rank time.
 *
 * Bounded to ±8%: personalisation should break ties, never override relevance.
 * An unbounded taste term is how discovery products end up in a filter bubble
 * that only ever shows one aesthetic.
 */
export const TASTE_MAX_EFFECT = 0.08;

export function tasteFactor(product: Product, session?: SessionData): number {
  const taste = session?.taste;
  if (!taste) return 1;

  const tokens = [...product.style_tags, ...product.materials, ...product.colors];
  if (!tokens.length) return 1;

  let sum = 0;
  let matched = 0;
  for (const token of tokens) {
    const w = taste[token];
    if (typeof w === 'number' && Number.isFinite(w)) {
      sum += Math.max(-1, Math.min(1, w));
      matched++;
    }
  }
  if (!matched) return 1;

  const mean = sum / matched;
  return 1 + mean * TASTE_MAX_EFFECT;
}

export interface ScoreInput {
  fused: FusedHit;
  product: Product;
  brandTrust: number;
  parse: ParsedQuery;
  now: number;
  session?: SessionData;
}

export function scoreItem(input: ScoreInput): { score: number; parts: Record<string, number> } {
  const { fused, product, brandTrust, parse, now, session } = input;

  const base = fused.score;
  const trust = trustFactor(brandTrust);
  const fresh = freshnessFactor(product.last_verified_at, now);
  const pop = popularityFactor(product.popularity);

  // Reward candidates found by more than one arm — agreement between lexical and
  // semantic recall is the strongest precision signal available without labels.
  const agreement = fused.arms.length >= 2 ? 1.12 : 1.0;

  // Exact structured hits the recall arms may have matched only fuzzily.
  let exact = 1.0;
  if (parse.categories.length && parse.categories.includes(product.category)) exact += 0.08;
  if (parse.colors.length && product.colors.some((c) => parse.colors.includes(c))) exact += 0.05;
  if (parse.materials.length && product.materials.some((m) => parse.materials.includes(m)))
    exact += 0.05;
  if (parse.occasions.length && product.occasions.some((o) => parse.occasions.includes(o)))
    exact += 0.05;

  // Out-of-stock never reaches here (filtered in recall); low stock is a mild
  // demotion because it converts worse and frustrates users.
  const stock = product.availability === 'low_stock' ? 0.95 : 1.0;

  const taste = tasteFactor(product, session);

  const score = base * trust * fresh * pop * agreement * exact * stock * taste;
  return {
    score,
    parts: { base, trust, fresh, pop, agreement, exact, stock, taste },
  };
}

// ---------------------------------------------------------------- match reasons

/**
 * Why this result is here, in the user's language. This is the transparency
 * device that makes an opaque ranker feel steerable rather than arbitrary.
 */
export function matchReasons(product: Product, parse: ParsedQuery): string[] {
  const reasons: string[] = [];

  for (const m of product.materials) {
    if (parse.materials.includes(m)) reasons.push(label(m));
  }
  for (const c of product.colors) {
    if (parse.colors.includes(c)) reasons.push(label(c));
  }
  for (const o of product.occasions) {
    if (parse.occasions.includes(o)) reasons.push(label(o));
  }
  for (const s of product.style_tags) {
    if (parse.style_tags.includes(s)) reasons.push(label(s));
  }
  if (parse.price_max !== undefined && product.price <= parse.price_max) {
    reasons.push(`Under ${formatINR(parse.price_max)}`);
  }
  if (parse.sizes.length && product.sizes.some((s) => parse.sizes.includes(s.toLowerCase()))) {
    reasons.push(`Size ${parse.sizes[0].toUpperCase()}`);
  }
  if (parse.like_brands.length) {
    reasons.push(`Similar to ${parse.like_brands[0]}`);
  }

  return unique(reasons).slice(0, 3);
}

// ---------------------------------------------------------------- relaxations

/**
 * One-tap ways to widen a search that returned nothing. Ordered by how much of
 * the user's original intent each one preserves.
 */
export function buildRelaxations(parse: ParsedQuery, raw: string, binding: string | null): Relaxation[] {
  const out: Relaxation[] = [];

  if (parse.price_max !== undefined) {
    const widened = Math.round((parse.price_max * 1.5) / 100_000) * 1_000;
    out.push({
      label: `Raise budget to ${formatINR(widened * 100)}`,
      query: raw.replace(
        /(?:under|below|less than|upto|up to|within)\s*(?:rs\.?|inr|₹)?\s*[\d.,]+\s*(?:k|lakh|lac)?/i,
        `under ₹${widened}`,
      ),
      removed: 'price_max',
    });
  }
  if (parse.sizes.length) {
    out.push({
      label: 'Any size',
      query: raw.replace(/\bsize\s*[\dxsml]+\b/gi, '').trim(),
      removed: 'sizes',
    });
  }
  if (parse.exclude_colors.length) {
    out.push({
      label: `Allow ${parse.exclude_colors.map(label).join(', ')}`,
      query: raw.replace(
        /\b(?:not|no|without|avoid|excluding)\s+[\p{L}\s-]{2,20}/giu,
        '',
      ).trim(),
      removed: 'exclude_colors',
    });
  }
  if (parse.materials.length) {
    out.push({
      label: `Any fabric`,
      query: [...parse.categories.map(label), ...parse.occasions.map(label)].join(' ') || raw,
      removed: 'materials',
    });
  }
  if (parse.categories.length > 0 && parse.occasions.length > 0) {
    out.push({
      label: `All ${parse.categories.map(label).join(' & ').toLowerCase()}`,
      query: parse.categories.map((c) => c.replace(/-/g, ' ')).join(' '),
      removed: 'occasions',
    });
  }

  // Put the constraint we know was binding first — it is the most likely fix.
  if (binding) {
    const idx = out.findIndex((r) => r.removed === binding);
    if (idx > 0) out.unshift(...out.splice(idx, 1));
  }

  return out.slice(0, 3);
}
