import type { Gender, Intent, ParsedQuery } from '../types';
import { unique } from '../lib/util';
import {
  ALPHA_SIZES,
  CATEGORY_INDEX,
  COLOR_INDEX,
  COMPLEMENTS,
  GENDER_INDEX,
  MATERIAL_INDEX,
  OCCASION_INDEX,
  STYLE_INDEX,
  matchTokens,
} from './lexicon';

/**
 * Deterministic query parser.
 *
 * This is the floor of the AI stack (ADR-5): it never fails, never costs money,
 * and returns in well under a millisecond. Every LLM provider falls back to it,
 * so a total inference outage degrades relevance without ever producing an
 * error page.
 *
 * It is also the seed for the LLM prompt — giving the model a pre-extracted
 * skeleton measurably improves its structured output.
 */

const NEG_PATTERN =
  /\b(?:not|no|without|avoid|avoiding|nothing|non|except|other than|minus|excluding|anything but|but not)\s+([\p{L}\p{N}\s-]{2,28})/giu;

const PRICE_UNDER =
  /(?:under|below|less than|lesser than|cheaper than|upto|up to|within|max|maximum|budget of|around|about|<=?)\s*(?:rs\.?|inr|₹)?\s*([\d.,]+\s*(?:k|lakh|lac|l)?)/i;
const PRICE_OVER =
  /(?:over|above|more than|at least|minimum|min|starting|from|>=?)\s*(?:rs\.?|inr|₹)?\s*([\d.,]+\s*(?:k|lakh|lac|l)?)/i;
const PRICE_BETWEEN =
  /(?:between|from)?\s*(?:rs\.?|inr|₹)?\s*([\d.,]+\s*(?:k|lakh|lac|l)?)\s*(?:-|–|to|and)\s*(?:rs\.?|inr|₹)?\s*([\d.,]+\s*(?:k|lakh|lac|l)?)/i;
/** A bare price with a currency marker: shoppers mean "at most this". */
const PRICE_BARE = /(?:rs\.?|inr|₹)\s*([\d.,]+\s*(?:k|lakh|lac|l)?)|(\b[\d.,]+\s*k\b)/i;

const SIZE_ALPHA = /\bsize\s*(xxs|xs|s|m|l|xl|xxl|3xl|4xl|5xl)\b/i;
const SIZE_NUM = /\bsize\s*(\d{1,2})\b/i;
const LIKE_BRAND =
  /\b(?:like|similar to|similar as|inspired by|vibe of|dupe for|dupes for|alternative to|instead of)\s+([\p{Lu}][\p{L}&'.-]*(?:\s+[\p{Lu}][\p{L}&'.-]*){0,2})/u;

const STYLING_PROBLEM =
  /\b(?:goes with|go with|what to wear with|wear with|pair with|pairs with|style with|styling|match with|matches with|to go with|complete)\b/i;

/** Parse "4k" / "1.5k" / "4,000" / "1 lakh" to a rupee number. */
export function parseAmount(raw: string): number | null {
  const s = raw.toLowerCase().replace(/,/g, '').replace(/\s+/g, '');
  const m = /^([\d.]+)(k|lakh|lac|l)?$/.exec(s);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const suffix = m[2];
  let rupees = n;
  if (suffix === 'k') rupees = n * 1_000;
  else if (suffix === 'lakh' || suffix === 'lac' || suffix === 'l') rupees = n * 100_000;
  // Guard against absurd values that would poison the SQL range filter.
  if (rupees < 1 || rupees > 100_000_000) return null;
  return Math.round(rupees);
}

const toPaise = (rupees: number) => rupees * 100;

interface PriceResult {
  min?: number;
  max?: number;
  /** Substrings to strip from semantic text. */
  consumed: string[];
}

export function extractPrice(q: string): PriceResult {
  const consumed: string[] = [];

  // "between 2000 and 5000" must be tried first — its digits would otherwise be
  // swallowed by the single-bound patterns.
  const between = PRICE_BETWEEN.exec(q);
  if (between && /between|from|-|–|\bto\b|\band\b/i.test(between[0])) {
    const a = parseAmount(between[1]);
    const b = parseAmount(between[2]);
    if (a !== null && b !== null && a !== b) {
      consumed.push(between[0]);
      return { min: toPaise(Math.min(a, b)), max: toPaise(Math.max(a, b)), consumed };
    }
  }

  let min: number | undefined;
  let max: number | undefined;

  const under = PRICE_UNDER.exec(q);
  if (under) {
    const v = parseAmount(under[1]);
    if (v !== null) {
      max = toPaise(v);
      consumed.push(under[0]);
    }
  }

  const over = PRICE_OVER.exec(q);
  if (over) {
    const v = parseAmount(over[1]);
    if (v !== null) {
      min = toPaise(v);
      consumed.push(over[0]);
    }
  }

  if (min === undefined && max === undefined) {
    const bare = PRICE_BARE.exec(q);
    if (bare) {
      const v = parseAmount(bare[1] ?? bare[2] ?? '');
      if (v !== null) {
        max = toPaise(v);
        consumed.push(bare[0]);
      }
    }
  }

  // A nonsensical range (min above max) means we misread the query; drop the
  // weaker bound rather than returning a filter that can only match nothing.
  if (min !== undefined && max !== undefined && min > max) min = undefined;

  return { min, max, consumed };
}

export interface Negations {
  colors: string[];
  materials: string[];
  styles: string[];
  terms: string[];
  consumed: string[];
}

export function extractNegations(q: string): Negations {
  const out: Negations = { colors: [], materials: [], styles: [], terms: [], consumed: [] };
  for (const m of q.matchAll(NEG_PATTERN)) {
    const span = m[1].trim();
    if (!span) continue;
    out.consumed.push(m[0]);

    const colors = matchTokens(span, COLOR_INDEX);
    const materials = matchTokens(span, MATERIAL_INDEX);
    const styles = matchTokens(span, STYLE_INDEX);
    out.colors.push(...colors);
    out.materials.push(...materials);
    out.styles.push(...styles);

    if (!colors.length && !materials.length && !styles.length) {
      // Keep the first two words only — "no print on the sleeves" → "print on".
      out.terms.push(span.split(/\s+/).slice(0, 2).join(' '));
    }
  }
  out.colors = unique(out.colors);
  out.materials = unique(out.materials);
  out.styles = unique(out.styles);
  out.terms = unique(out.terms);
  return out;
}

function classifyIntent(input: {
  raw: string;
  categories: string[];
  occasions: string[];
  styles: string[];
  likeBrands: string[];
  hasPrice: boolean;
  hasSize: boolean;
}): Intent {
  if (STYLING_PROBLEM.test(input.raw)) return 'styling_problem';
  if (input.likeBrands.length) return 'brand_reference';
  if (input.hasPrice || input.hasSize) return 'constraint';
  if (input.occasions.length) return 'occasion';
  if (input.styles.length) return 'mood';
  if (input.categories.length) return 'browse';
  return 'mood';
}

/** Remove consumed spans and stop-words to leave clean text for embedding. */
function buildSemanticText(raw: string, consumed: string[]): string {
  let s = ' ' + raw.toLowerCase() + ' ';
  // Longest first so overlapping spans are removed cleanly.
  for (const span of [...consumed].sort((a, b) => b.length - a.length)) {
    if (!span.trim()) continue;
    s = s.split(span.toLowerCase()).join(' ');
  }
  s = s
    .replace(/\b(?:i|me|my|need|want|looking for|show me|find me|find|get me|some|a|an|the|for|of|that|is|are|to|with|please|something|anything)\b/g, ' ')
    .replace(/[^\p{L}\p{N}°\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}

export function heuristicParse(rawQuery: string): ParsedQuery {
  const raw = rawQuery.trim();
  const lower = raw.toLowerCase();

  const negations = extractNegations(raw);
  const price = extractPrice(lower);

  // Strip negated spans before positive matching, so "not white" never yields
  // white as a wanted colour.
  let positive = ' ' + lower + ' ';
  for (const span of negations.consumed) positive = positive.split(span.toLowerCase()).join(' ');

  const consumed = [...negations.consumed, ...price.consumed];

  const sizes: string[] = [];
  const alpha = SIZE_ALPHA.exec(raw);
  if (alpha) {
    sizes.push(alpha[1].toLowerCase());
    consumed.push(alpha[0]);
  }
  const numeric = SIZE_NUM.exec(raw);
  if (numeric) {
    sizes.push(numeric[1]);
    consumed.push(numeric[0]);
  }
  // A bare alpha size token only counts when unambiguous ("size" prefix absent
  // but the token stands alone, e.g. "xl oversized tee").
  for (const tok of lower.split(/\s+/)) {
    if (ALPHA_SIZES.includes(tok) && tok.length >= 2 && !sizes.includes(tok)) sizes.push(tok);
  }

  const likeBrandMatch = LIKE_BRAND.exec(raw);
  const likeBrands = likeBrandMatch ? [likeBrandMatch[1].trim()] : [];
  if (likeBrandMatch) consumed.push(likeBrandMatch[0]);

  let categories = matchTokens(positive, CATEGORY_INDEX);
  const colors = matchTokens(positive, COLOR_INDEX).filter((c) => !negations.colors.includes(c));
  const materials = matchTokens(positive, MATERIAL_INDEX).filter(
    (m) => !negations.materials.includes(m),
  );
  const occasions = matchTokens(positive, OCCASION_INDEX);
  const styles = matchTokens(positive, STYLE_INDEX).filter((s) => !negations.styles.includes(s));

  const genderMatches = matchTokens(positive, GENDER_INDEX);
  const gender = (genderMatches[0] as Gender | undefined) ?? undefined;

  const intent = classifyIntent({
    raw,
    categories,
    occasions,
    styles,
    likeBrands,
    hasPrice: price.min !== undefined || price.max !== undefined,
    hasSize: sizes.length > 0,
  });

  // "what goes with olive trousers": the mentioned category is the anchor, not
  // the thing being shopped for. Swap in its complements (U4).
  if (intent === 'styling_problem' && categories.length) {
    const complements = unique(categories.flatMap((c) => COMPLEMENTS[c] ?? []));
    if (complements.length) categories = complements;
  }

  const semantic_text = buildSemanticText(raw, consumed) || lower;

  // Confidence rises with how much structure we actually recovered — the search
  // layer widens recall when this is low.
  const signals = [
    categories.length,
    colors.length,
    materials.length,
    occasions.length,
    styles.length,
  ].filter((n) => n > 0).length;
  const confidence = Math.min(0.8, 0.35 + signals * 0.11);

  return {
    semantic_text,
    intent,
    categories,
    gender,
    colors,
    exclude_colors: negations.colors,
    materials,
    occasions,
    style_tags: styles,
    brands: [],
    like_brands: likeBrands,
    price_min: price.min,
    price_max: price.max,
    sizes: unique(sizes),
    exclude_terms: [...negations.terms, ...negations.materials, ...negations.styles],
    confidence,
    provider: 'heuristic',
  };
}
