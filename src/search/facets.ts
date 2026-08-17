import type { Facets, FacetBucket, ResultItem } from '../types';
import { PRICE_BANDS, label } from '../ai/lexicon';

/**
 * Facet counts computed from the post-filter candidate set.
 *
 * Deliberately not a separate set of SQL COUNT queries: on D1 that would be
 * seven extra round-trips per search, and counts over the candidate pool are
 * what the user can actually navigate to anyway.
 */

function tally(
  items: ResultItem[],
  pick: (item: ResultItem) => string[],
  labelFn: (v: string) => string = label,
  limit = 12,
): FacetBucket[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const v of new Set(pick(item))) {
      if (!v) continue;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, label: labelFn(value), count }));
}

export function computeFacets(items: ResultItem[]): Facets {
  const priceBands: FacetBucket[] = PRICE_BANDS.map((band) => ({
    value: band.value,
    label: band.label,
    count: items.filter(
      (i) => i.price >= band.min && (band.max === null || i.price < band.max),
    ).length,
  })).filter((b) => b.count > 0);

  return {
    category: tally(items, (i) => [i.category]),
    brand: tally(
      items,
      (i) => [i.brand_slug],
      (slug) => items.find((i) => i.brand_slug === slug)?.brand_name ?? label(slug),
      16,
    ),
    color: tally(items, (i) => i.colors),
    material: tally(items, (i) => i.materials),
    occasion: tally(items, (i) => i.occasions),
    price_band: priceBands,
    // Sizes keep their own casing — "XL" not "Xl".
    size: tally(items, (i) => i.sizes, (v) => v.toUpperCase(), 16),
  };
}

/** Which price band a paise value falls in. Used to preselect the facet. */
export function priceBandFor(paise: number): string | null {
  const band = PRICE_BANDS.find((b) => paise >= b.min && (b.max === null || paise < b.max));
  return band?.value ?? null;
}

export function priceBandRange(value: string): { min: number; max: number | null } | null {
  const band = PRICE_BANDS.find((b) => b.value === value);
  return band ? { min: band.min, max: band.max } : null;
}
