import { describe, expect, it, vi } from 'vitest';
import {
  clamp,
  discountPct,
  esc,
  escJson,
  formatINR,
  ftsQuote,
  isBotUA,
  isPlaceholderHostname,
  normaliseQuery,
  safeEqual,
  safeJson,
  slugify,
  timeAgo,
  truncate,
} from '../src/lib/util';
import { extractNegations, extractPrice, heuristicParse, parseAmount } from '../src/ai/heuristic';
import { matchTokens, COLOR_INDEX, CATEGORY_INDEX, PRICE_BANDS } from '../src/ai/lexicon';
import {
  applyFilters,
  buildRelaxations,
  freshnessFactor,
  fuse,
  matchReasons,
  popularityFactor,
  tasteFactor,
  trustFactor,
} from '../src/search/rank';
import { buildFtsQuery } from '../src/search/lexical';
import { dot, packId, quantise, toSimilarity, unpackId, ID_WIDTH } from '../src/search/vector';
import {
  assertSafeUrl,
  fetchFeed,
  parseCsv,
  parseCsvRows,
  parseGoogleMerchant,
  parseShopify,
  parseSouledStoreListing,
  SHOPIFY_MAX_BYTES,
  SHOPIFY_MAX_PAGE_REQUESTS,
  SHOPIFY_PAGE_SIZE,
  SOULED_STORE_API,
  SOULED_STORE_PAGE_SIZE,
} from '../src/ingest/adapters';
import { normaliseItem, contentHash, embedText } from '../src/ingest/normalize';
import { computeFacets, priceBandRange } from '../src/search/facets';
import { toParsedQuery } from '../src/ai/provider';
import { rateIdentity, rateLimit, RULES } from '../src/lib/ratelimit';
import { applyUrlFilters, validatedSearchParams } from '../src/routes/pages';
import { drainStylistBuffer } from '../src/routes/api';
import { filterRail, pagination, sortSelect } from '../src/ui/components';
import { configurationReadiness } from '../src/lib/readiness';
import type { Env, ParsedQuery, Product, ResultItem } from '../src/types';

// ============================================================ configuration readiness

describe('configuration readiness', () => {
  const base = {
    SITE_URL: 'https://vestiq.example',
  } as Env;

  it('requires a declared dependable scheduler, not merely disabled piggybacking', () => {
    expect(configurationReadiness({ ...base, SCHEDULER_PIGGYBACK: '0' }).scheduler.ok).toBe(false);
    expect(
      configurationReadiness({
        ...base,
        SCHEDULER_PIGGYBACK: '0',
        SCHEDULER_DRIVER: 'github-actions',
      }).scheduler.ok,
    ).toBe(true);
  });

  it('does not treat traffic piggybacking as a dependable alert driver', () => {
    const check = configurationReadiness({ ...base, SCHEDULER_PIGGYBACK: '1' }).scheduler;
    expect(check.ok).toBe(false);
    expect(check.note).toContain('traffic-driven only');
  });
});

// ============================================================ util

describe('money', () => {
  it('formats paise as Indian rupees with grouping', () => {
    expect(formatINR(199_900)).toBe('₹1,999');
    expect(formatINR(10_000_000)).toBe('₹1,00,000');
    expect(formatINR(0)).toBe('₹0');
  });

  it('returns a dash for missing values rather than NaN', () => {
    expect(formatINR(null)).toBe('—');
    expect(formatINR(undefined)).toBe('—');
    expect(formatINR(NaN)).toBe('—');
  });

  it('never reports a discount when MRP is not above price', () => {
    expect(discountPct(1000, 1000)).toBe(0);
    expect(discountPct(1000, 900)).toBe(0);
    expect(discountPct(1000, null)).toBe(0);
    expect(discountPct(500, 1000)).toBe(50);
  });
});

describe('escaping', () => {
  it('escapes HTML-significant characters', () => {
    expect(esc('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
    expect(esc("it's")).toBe('it&#39;s');
  });

  it('escapes nothing dangerous into a script context', () => {
    const out = escJson({ evil: '</script><script>alert(1)</script>' });
    expect(out).not.toContain('</script>');
    expect(out).toContain('\\u003c');
  });

  it('handles null and undefined', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
  });

  it('quotes FTS tokens so operators cannot be injected', () => {
    // Without quoting, `NOT` / `*` / `"` would be parsed as FTS5 syntax.
    expect(ftsQuote('cotton')).toBe('"cotton"');
    expect(ftsQuote('a" OR b')).toBe('"a"" OR b"');
  });
});

describe('safeEqual', () => {
  it('matches identical strings and rejects others', () => {
    expect(safeEqual('secret', 'secret')).toBe(true);
    expect(safeEqual('secret', 'secreT')).toBe(false);
    expect(safeEqual('secret', 'secret-longer')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});

describe('misc helpers', () => {
  it('slugifies unicode and punctuation', () => {
    expect(slugify('Café Kurta — Blue!')).toBe('cafe-kurta-blue');
    expect(slugify('   ')).toBe('item');
  });

  it('identifies reserved merchant destinations without blocking real domains', () => {
    expect(isPlaceholderHostname('solesand.example.in')).toBe(true);
    expect(isPlaceholderHostname('https://brand.example/products.json')).toBe(true);
    expect(isPlaceholderHostname('shop.test')).toBe(true);
    expect(isPlaceholderHostname('test')).toBe(true);
    expect(isPlaceholderHostname('example.com')).toBe(true);
    expect(isPlaceholderHostname('localhost')).toBe(true);
    expect(isPlaceholderHostname('okhai.org')).toBe(false);
    expect(isPlaceholderHostname('https://shop.nicobar.com/products.json')).toBe(false);
  });

  it('truncates with an ellipsis only when needed', () => {
    expect(truncate('short', 10)).toBe('short');
    expect(truncate('a'.repeat(20), 10)).toHaveLength(10);
  });

  it('falls back safely on malformed JSON', () => {
    expect(safeJson('not json', ['x'])).toEqual(['x']);
    expect(safeJson('null', ['x'])).toEqual(['x']);
    expect(safeJson('["a"]', [])).toEqual(['a']);
  });

  it('clamps', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-5, 0, 3)).toBe(0);
  });

  it('normalises queries for cache keys', () => {
    expect(normaliseQuery('  Cotton   KURTA!!  ')).toBe('cotton kurta');
    // The rupee sign and comparison operators survive: they carry price meaning.
    expect(normaliseQuery('under ₹4000')).toContain('₹4000');
  });

  it('formats relative time', () => {
    const now = 1_700_000_000_000;
    expect(timeAgo(now - 30_000, now)).toBe('just now');
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(timeAgo(now - 5 * 86_400_000, now)).toBe('5d ago');
    expect(timeAgo(null, now)).toBe('unknown');
  });

  it('detects crawlers', () => {
    expect(isBotUA('Mozilla/5.0 (compatible; Googlebot/2.1)')).toBe(true);
    expect(isBotUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)')).toBe(false);
  });
});

// ============================================================ lexicon

describe('lexicon matching', () => {
  it('matches on word boundaries, not substrings', () => {
    // "tan" must not match inside "instant"
    expect(matchTokens('instant noodles', COLOR_INDEX)).not.toContain('tan');
    expect(matchTokens('a tan bag', COLOR_INDEX)).toContain('tan');
  });

  it('prefers the longest surface form', () => {
    // "kurta set" must win over "kurta"
    const matched = matchTokens('cotton kurta set for diwali', CATEGORY_INDEX);
    expect(matched[0]).toBe('kurta-sets');
  });

  it('has contiguous, non-overlapping price bands', () => {
    for (let i = 1; i < PRICE_BANDS.length; i++) {
      expect(PRICE_BANDS[i].min).toBe(PRICE_BANDS[i - 1].max);
    }
    expect(PRICE_BANDS[PRICE_BANDS.length - 1].max).toBeNull();
  });
});

// ============================================================ heuristic parser

describe('parseAmount', () => {
  it('handles k, lakh, commas and decimals', () => {
    expect(parseAmount('4000')).toBe(4000);
    expect(parseAmount('4,000')).toBe(4000);
    expect(parseAmount('4k')).toBe(4000);
    expect(parseAmount('1.5k')).toBe(1500);
    expect(parseAmount('2 lakh')).toBe(200_000);
  });

  it('rejects junk and absurd values', () => {
    expect(parseAmount('abc')).toBeNull();
    expect(parseAmount('0')).toBeNull();
    expect(parseAmount('999999999999')).toBeNull();
  });
});

describe('extractPrice', () => {
  it('reads an upper bound', () => {
    expect(extractPrice('kitten heels under ₹4000').max).toBe(400_000);
    expect(extractPrice('dresses below 2.5k').max).toBe(250_000);
    expect(extractPrice('tops upto 999').max).toBe(99_900);
  });

  it('reads a lower bound', () => {
    expect(extractPrice('sarees above 10000').min).toBe(1_000_000);
  });

  it('reads a range', () => {
    const result = extractPrice('dresses between 2000 and 5000');
    expect(result.min).toBe(200_000);
    expect(result.max).toBe(500_000);
  });

  it('normalises an inverted range rather than returning an impossible filter', () => {
    const result = extractPrice('between 5000 and 2000');
    expect(result.min).toBe(200_000);
    expect(result.max).toBe(500_000);
  });

  it('treats a bare currency amount as a budget ceiling', () => {
    expect(extractPrice('co-ord set ₹3000').max).toBe(300_000);
    expect(extractPrice('co-ord set 3k').max).toBe(300_000);
  });

  it('drops a lower bound that exceeds the upper bound', () => {
    // "above 5000 under 2000" is incoherent; keeping both guarantees zero results.
    const result = extractPrice('above 5000 under 2000');
    expect(result.max).toBe(200_000);
    expect(result.min).toBeUndefined();
  });
});

describe('extractNegations', () => {
  it('maps negated colours to exclusions', () => {
    expect(extractNegations('beach wedding, not white').colors).toContain('white');
    expect(extractNegations('anything but black').colors).toContain('black');
  });

  it('keeps unmapped negations as free-text terms', () => {
    expect(extractNegations('dress with no print').terms.length).toBeGreaterThan(0);
  });
});

describe('heuristicParse', () => {
  it('never puts a negated colour in the positive colour list', () => {
    const parse = heuristicParse('beach wedding guest dress, not white');
    expect(parse.exclude_colors).toContain('white');
    expect(parse.colors).not.toContain('white');
  });

  it('classifies a constraint query', () => {
    const parse = heuristicParse('kitten heels under ₹4000');
    expect(parse.intent).toBe('constraint');
    expect(parse.categories).toContain('heels');
    expect(parse.price_max).toBe(400_000);
  });

  it('classifies an occasion query', () => {
    const parse = heuristicParse('matching co-ord set for a Goa vacation');
    expect(parse.intent).toBe('occasion');
    expect(parse.categories).toContain('co-ord-sets');
    expect(parse.occasions).toContain('vacation');
  });

  it('swaps in complements for a styling problem', () => {
    // The trousers are what they own; they want things to wear with them.
    const parse = heuristicParse('what goes with wide-leg olive trousers');
    expect(parse.intent).toBe('styling_problem');
    expect(parse.categories).not.toContain('trousers');
    expect(parse.categories.length).toBeGreaterThan(0);
    expect(parse.categories).toContain('tops');
  });

  it('treats a brand reference as a style hint, not a hard filter', () => {
    const parse = heuristicParse('something like Sabyasachi but under ₹6000');
    expect(parse.intent).toBe('brand_reference');
    expect(parse.like_brands[0]).toContain('Sabyasachi');
    expect(parse.brands).toHaveLength(0);
    expect(parse.price_max).toBe(600_000);
  });

  it('reads weather cues as occasions', () => {
    const parse = heuristicParse('quiet luxury but for 35°C');
    expect(parse.style_tags).toContain('quiet-luxury');
    expect(parse.occasions).toContain('summer');
  });

  it('strips price text from the semantic text', () => {
    const parse = heuristicParse('linen shirt under ₹2000');
    expect(parse.semantic_text).not.toMatch(/2000/);
    expect(parse.semantic_text).toContain('linen');
  });

  it('always returns a usable parse for gibberish', () => {
    const parse = heuristicParse('asdkjfh qwerty');
    expect(parse.semantic_text.length).toBeGreaterThan(0);
    expect(parse.confidence).toBeGreaterThan(0);
  });

  it('extracts sizes', () => {
    expect(heuristicParse('sneakers size 39').sizes).toContain('39');
    expect(heuristicParse('kurta size M').sizes).toContain('m');
  });
});

// ============================================================ AI output validation

describe('toParsedQuery', () => {
  const seed = heuristicParse('cotton kurta');

  it('drops values that are not in our lexicon', () => {
    const out = toParsedQuery(
      { semantic_text: 'x', intent: 'mood', colors: ['blue', 'sparkleflorbium'], confidence: 0.8 },
      seed,
      'test',
    );
    expect(out?.colors).toContain('blue');
    expect(out?.colors).not.toContain('sparkleflorbium');
  });

  it('converts rupees to paise', () => {
    const out = toParsedQuery(
      { semantic_text: 'x', intent: 'constraint', price_max_rupees: 4000, confidence: 0.9 },
      seed,
      'test',
    );
    expect(out?.price_max).toBe(400_000);
  });

  it('discards an inverted price range from the model', () => {
    const out = toParsedQuery(
      {
        semantic_text: 'x',
        intent: 'constraint',
        price_min_rupees: 9000,
        price_max_rupees: 1000,
        confidence: 0.9,
      },
      seed,
      'test',
    );
    expect(out?.price_max).toBe(100_000);
    expect(out?.price_min).toBeUndefined();
  });

  it('returns null on structurally invalid output so the caller can fall back', () => {
    expect(toParsedQuery({ intent: 'not-a-real-intent' }, seed, 'test')).toBeNull();
    expect(toParsedQuery('a string', seed, 'test')).toBeNull();
  });

  it('preserves the heuristic seed when the model omits a field', () => {
    const priceSeed = heuristicParse('kurta under 2000');
    const out = toParsedQuery(
      { semantic_text: 'kurta', intent: 'constraint', confidence: 0.7 },
      priceSeed,
      'test',
    );
    expect(out?.price_max).toBe(200_000);
  });
});

// ============================================================ fusion & ranking

describe('reciprocal rank fusion', () => {
  it('ranks a document found by both arms above one found by a single arm', () => {
    const fused = fuse([
      { name: 'lexical', hits: [{ id: 'a', score: 10 }, { id: 'b', score: 9 }], weight: 1 },
      { name: 'semantic', hits: [{ id: 'b', score: 0.9 }, { id: 'c', score: 0.8 }], weight: 1 },
    ]);
    expect(fused[0].id).toBe('b');
    expect(fused[0].arms).toEqual(expect.arrayContaining(['lexical', 'semantic']));
  });

  it('is robust to an unsorted arm', () => {
    const fused = fuse([
      { name: 'lexical', hits: [{ id: 'low', score: 1 }, { id: 'high', score: 100 }], weight: 1 },
    ]);
    expect(fused[0].id).toBe('high');
  });

  it('returns an empty list for no arms', () => {
    expect(fuse([])).toEqual([]);
  });
});

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p1',
    brand_id: 'b1',
    external_id: null,
    slug: 'test',
    title: 'Cotton Kurta',
    description: 'A cotton kurta',
    category: 'kurtas',
    subcategory: null,
    gender: 'women',
    price: 200_000,
    mrp: 300_000,
    currency: 'INR',
    url: 'https://example.in/p',
    image_url: 'https://cdn.shopify.com/s/files/1/test/products/x.jpg',
    images: [],
    colors: ['blue'],
    sizes: ['s', 'm'],
    materials: ['cotton'],
    occasions: ['casual'],
    style_tags: ['minimal'],
    attributes: {},
    availability: 'in_stock',
    rating: 4,
    review_count: 5,
    popularity: 1,
    last_verified_at: Date.now(),
    first_seen_at: Date.now(),
    updated_at: Date.now(),
    status: 'active',
    ...overrides,
  };
}

describe('applyFilters', () => {
  const base: ParsedQuery = heuristicParse('');

  it('enforces a price ceiling', () => {
    const result = applyFilters(
      [makeProduct({ id: 'cheap', price: 100_000 }), makeProduct({ id: 'dear', price: 900_000 })],
      { ...base, price_max: 500_000 },
    );
    expect(result.kept.map((p) => p.id)).toEqual(['cheap']);
    expect(result.binding).toBe('price_max');
  });

  it('excludes negated colours', () => {
    const result = applyFilters(
      [makeProduct({ id: 'white', colors: ['white'] }), makeProduct({ id: 'blue', colors: ['blue'] })],
      { ...base, exclude_colors: ['white'] },
    );
    expect(result.kept.map((p) => p.id)).toEqual(['blue']);
  });

  it('treats unisex stock as valid for a gendered query', () => {
    const result = applyFilters(
      [makeProduct({ id: 'u', gender: 'unisex' }), makeProduct({ id: 'm', gender: 'men' })],
      { ...base, gender: 'women' },
    );
    expect(result.kept.map((p) => p.id)).toEqual(['u']);
  });

  it('reports the constraint that removed the most candidates', () => {
    const result = applyFilters(
      [
        makeProduct({ id: 'a', price: 900_000 }),
        makeProduct({ id: 'b', price: 900_000 }),
        makeProduct({ id: 'c', colors: ['white'] }),
      ],
      { ...base, price_max: 500_000, exclude_colors: ['white'] },
    );
    expect(result.binding).toBe('price_max');
  });

  it('does not claim a size match when the listing has no size data', () => {
    const result = applyFilters([makeProduct({ sizes: [] })], { ...base, sizes: ['xxl'] });
    expect(result.kept).toHaveLength(0);
    expect(result.binding).toBe('sizes');
  });

  it('enforces every positive constraint field, including stable brand slugs', () => {
    const matching = {
      ...makeProduct({ id: 'matching' }),
      brand_name: 'House One',
      brand_slug: 'house-one',
    };
    const parse: ParsedQuery = {
      ...base,
      categories: ['kurtas'],
      colors: ['blue'],
      materials: ['cotton'],
      occasions: ['casual'],
      style_tags: ['minimal'],
      sizes: ['m'],
      brands: ['house-one'],
      price_min: 100_000,
      price_max: 300_000,
    };
    expect(applyFilters([matching], parse).kept.map((p) => p.id)).toEqual(['matching']);

    const misses = [
      { category: 'tops' },
      { colors: ['red'] },
      { materials: ['silk'] },
      { occasions: ['wedding'] },
      { style_tags: ['boho'] },
      { sizes: ['xl'] },
      { brand_slug: 'house-two', brand_name: 'House Two', brand_id: 'b2' },
      { price: 900_000 },
    ];
    for (const [index, miss] of misses.entries()) {
      expect(
        applyFilters([{ ...matching, id: `miss-${index}`, ...miss }], parse).kept,
        JSON.stringify(miss),
      ).toHaveLength(0);
    }
  });

  it('ORs selections inside one facet group and ANDs across groups', () => {
    const products = [
      makeProduct({ id: 'cotton-blue', materials: ['cotton'], colors: ['blue'] }),
      makeProduct({ id: 'linen-red', materials: ['linen'], colors: ['red'] }),
      makeProduct({ id: 'silk-blue', materials: ['silk'], colors: ['blue'] }),
      makeProduct({ id: 'linen-green', materials: ['linen'], colors: ['green'] }),
    ];
    const result = applyFilters(products, {
      ...base,
      materials: ['cotton', 'linen'],
      colors: ['blue', 'red'],
    });
    expect(result.kept.map((p) => p.id)).toEqual(['cotton-blue', 'linen-red']);
  });
});

describe('validated search state', () => {
  it('caps and validates URL facets, sort, prices and brand slugs', () => {
    const raw = new URLSearchParams();
    raw.set('q', 'test');
    for (const color of ['black', 'white', 'ivory', 'beige', 'brown', 'tan', 'grey', 'navy', 'blue']) {
      raw.append('color', color);
    }
    raw.append('category', '<script>');
    raw.set('brand', 'house-one');
    raw.set('sort', 'DROP TABLE' as never);
    raw.set('max', '2000oops');
    raw.set('filters', '1');

    const clean = validatedSearchParams(raw);
    expect(clean.getAll('color')).toHaveLength(8);
    expect(clean.has('category')).toBe(false);
    expect(clean.get('brand')).toBe('house-one');
    expect(clean.has('sort')).toBe(false);
    expect(clean.has('max')).toBe(false);
    expect(clean.get('filters')).toBe('1');
  });

  it('uses the explicit form marker so unchecking inferred facets really clears them', () => {
    const base = {
      ...heuristicParse('blue cotton kurta size m'),
      brands: ['House One'],
    };
    const params = new URLSearchParams('q=x&filters=1&color=red');
    const out = applyUrlFilters(base, params);
    expect(out.colors).toEqual(['red']);
    expect(out.categories).toEqual([]);
    expect(out.materials).toEqual([]);
    expect(out.occasions).toEqual([]);
    expect(out.sizes).toEqual([]);
    expect(out.brands).toEqual([]);
  });

  it('preserves the complete state in filter, sort and pagination controls', () => {
    const active = new URLSearchParams(
      'q=linen&filters=1&color=blue&brand=house-one&sort=price_desc&page=2&drop=size%3Am',
    );
    const facets = computeFacets([
      { ...makeResultItem('a'), colors: ['blue'], brand_slug: 'house-one', brand_name: 'House One' },
    ]);
    const rail = filterRail(facets, 'linen', active, {
      ...heuristicParse('linen'),
      colors: ['blue'],
      brands: ['house-one'],
    });
    expect(rail).toContain('class="mobile-filters"');
    expect(rail).toContain('name="filters" value="1"');
    expect(rail).toContain('name="sort" value="price_desc"');
    expect(rail).toContain('name="color" value="blue" checked');

    const sort = sortSelect('price_desc', 'linen', active);
    expect(sort).toContain('name="color" value="blue"');
    expect(sort).toContain('name="brand" value="house-one"');
    expect(sort).not.toContain('name="page"');

    const pager = pagination(2, true, '/search?q=linen&filters=1&color=blue&sort=price_desc');
    expect(pager).toContain('color=blue');
    expect(pager).toContain('sort=price_desc');
    expect((pager.match(/q=linen/g) ?? [])).toHaveLength(2);
  });
});

describe('stylist stream marker buffering', () => {
  const source = 'Before [[SEARCH: cotton kurta]] after';

  const consume = (chunks: string[]) => {
    let pending = '';
    const parts: { type: 'text' | 'search'; value: string }[] = [];
    for (const chunk of chunks) {
      pending += chunk;
      const drained = drainStylistBuffer(pending);
      pending = drained.pending;
      parts.push(...drained.parts);
    }
    const final = drainStylistBuffer(pending, true);
    parts.push(...final.parts);
    return parts;
  };

  it('recognises a marker across every pair of chunk boundaries', () => {
    for (let first = 0; first <= source.length; first++) {
      for (let second = first; second <= source.length; second++) {
        const parts = consume([
          source.slice(0, first),
          source.slice(first, second),
          source.slice(second),
        ]);
        expect(parts.filter((p) => p.type === 'search').map((p) => p.value)).toEqual([
          'cotton kurta',
        ]);
        expect(parts.filter((p) => p.type === 'text').map((p) => p.value).join('')).toBe(
          'Before  after',
        );
      }
    }
  });

  it('handles one-character chunks without leaking marker syntax', () => {
    const parts = consume([...source]);
    expect(parts.filter((p) => p.type === 'search').map((p) => p.value)).toEqual([
      'cotton kurta',
    ]);
    expect(parts.filter((p) => p.type === 'text').map((p) => p.value).join('')).toBe(
      'Before  after',
    );
  });
});

describe('scoring factors', () => {
  it('demotes listings we have not verified recently', () => {
    const now = Date.now();
    expect(freshnessFactor(now, now)).toBe(1);
    expect(freshnessFactor(now - 10 * 86_400_000, now)).toBeLessThan(1);
    expect(freshnessFactor(now - 60 * 86_400_000, now)).toBeLessThan(
      freshnessFactor(now - 10 * 86_400_000, now),
    );
    expect(freshnessFactor(null, now)).toBeLessThan(1);
  });

  it('bounds the trust multiplier so trust cannot override relevance', () => {
    expect(trustFactor(0)).toBeCloseTo(0.85);
    expect(trustFactor(100)).toBeCloseTo(1.15);
    expect(trustFactor(999)).toBeCloseTo(1.15);
    expect(trustFactor(-50)).toBeCloseTo(0.85);
  });

  it('bounds the popularity multiplier', () => {
    expect(popularityFactor(0)).toBe(1);
    expect(popularityFactor(1_000_000)).toBeLessThanOrEqual(1.15);
  });

  it('bounds taste bias to ±8% and is neutral without a profile', () => {
    const product = makeProduct({ style_tags: ['minimal'], materials: ['cotton'], colors: [] });
    expect(tasteFactor(product, undefined)).toBe(1);
    const liked = tasteFactor(product, {
      id: 's',
      created_at: 0,
      last_seen_at: 0,
      recent_queries: [],
      taste: { minimal: 1, cotton: 1 },
    });
    expect(liked).toBeGreaterThan(1);
    expect(liked).toBeLessThanOrEqual(1.08);
  });
});

describe('matchReasons', () => {
  it('explains why a product matched, capped at three chips', () => {
    const parse: ParsedQuery = {
      ...heuristicParse(''),
      materials: ['cotton'],
      colors: ['blue'],
      occasions: ['casual'],
      style_tags: ['minimal'],
      price_max: 500_000,
    };
    const reasons = matchReasons(makeProduct(), parse);
    expect(reasons.length).toBeLessThanOrEqual(3);
    expect(reasons.join(' ')).toMatch(/Cotton|Blue|Casual/);
  });

  it('produces nothing when the query had no structured constraints', () => {
    expect(matchReasons(makeProduct(), heuristicParse(''))).toEqual([]);
  });
});

// ============================================================ ADR-10 invariant

function makeResultItem(id: string): ResultItem {
  return {
    ...makeProduct({ id }),
    brand_name: 'Brand',
    brand_slug: 'brand',
    brand_trust: 70,
    brand_ship_days: 3,
    score: 1,
    match_reasons: [],
  };
}

// ============================================================ relaxations

describe('buildRelaxations', () => {
  it('offers a higher budget when price was the binding constraint', () => {
    const parse = heuristicParse('kitten heels under ₹4000');
    const relaxations = buildRelaxations(parse, 'kitten heels under ₹4000', 'price_max');
    expect(relaxations.length).toBeGreaterThan(0);
    expect(relaxations[0].removed).toBe('price_max');
    expect(relaxations[0].query).not.toMatch(/4000/);
  });

  it('puts the binding constraint first', () => {
    const parse = heuristicParse('cotton kurta size xxl under 2000');
    const relaxations = buildRelaxations(parse, 'cotton kurta size xxl under 2000', 'sizes');
    expect(relaxations[0].removed).toBe('sizes');
  });

  it('caps at three options', () => {
    const parse = heuristicParse('cotton silk kurta set size m for wedding under 2000, not white');
    expect(buildRelaxations(parse, 'x', null).length).toBeLessThanOrEqual(3);
  });
});

// ============================================================ FTS query building

describe('buildFtsQuery', () => {
  it('ORs quoted tokens', () => {
    const query = buildFtsQuery(heuristicParse('cotton kurta set'));
    expect(query).toContain(' OR ');
    expect(query).toContain('"cotton"');
  });

  it('returns null when there is nothing to match', () => {
    expect(buildFtsQuery(heuristicParse(''))).toBeNull();
  });

  it('cannot emit bare FTS operators from user input', () => {
    const query = buildFtsQuery(heuristicParse('kurta NEAR/2 something* "quoted"'));
    // Every token must be inside quotes, so operators are literal text.
    const unquoted = (query ?? '').split(' OR ').filter((t) => !/^".*"$/.test(t));
    expect(unquoted).toEqual([]);
  });

  it('drops stop-words', () => {
    expect(buildFtsQuery(heuristicParse('a dress for the party'))).not.toContain('"the"');
  });
});

// ============================================================ vectors

describe('int8 vector index', () => {
  it('round-trips ids at the fixed width', () => {
    const buf = new Uint8Array(ID_WIDTH * 2);
    packId('p_abc123', buf, 0);
    packId('p_xyz', buf, ID_WIDTH);
    expect(unpackId(buf, 0)).toBe('p_abc123');
    expect(unpackId(buf, ID_WIDTH)).toBe('p_xyz');
  });

  it('rejects ids that would overflow the record', () => {
    expect(() => packId('x'.repeat(ID_WIDTH + 1), new Uint8Array(ID_WIDTH), 0)).toThrow();
  });

  it('quantises to a unit vector so dot product approximates cosine', () => {
    const a = quantise(new Float32Array([1, 0, 0, 0]));
    const b = quantise(new Float32Array([1, 0, 0, 0]));
    const c = quantise(new Float32Array([-1, 0, 0, 0]));
    expect(toSimilarity(dot(a, b))).toBeGreaterThan(0.99);
    expect(toSimilarity(dot(a, c))).toBeLessThan(0.01);
  });

  it('scales magnitude away, keeping only direction', () => {
    const small = quantise(new Float32Array([1, 1, 0, 0]));
    const large = quantise(new Float32Array([100, 100, 0, 0]));
    expect(Array.from(small)).toEqual(Array.from(large));
  });

  it('handles a zero vector without producing NaN', () => {
    const zero = quantise(new Float32Array([0, 0, 0, 0]));
    expect(Array.from(zero)).toEqual([0, 0, 0, 0]);
    expect(Number.isFinite(toSimilarity(dot(zero, zero)))).toBe(true);
  });

  it('restores sign when reading vectors out of a Uint8Array buffer', () => {
    const vec = quantise(new Float32Array([-1, 0, 0, 0]));
    const packed = new Uint8Array(4);
    packed.set(new Uint8Array(vec.buffer, vec.byteOffset, 4));
    expect(dot(quantise(new Float32Array([-1, 0, 0, 0])), packed, 0)).toBeGreaterThan(0);
  });
});

// ============================================================ facets

describe('facets', () => {
  it('counts buckets and resolves brand labels', () => {
    const items = [
      { ...makeResultItem('a'), colors: ['blue'], category: 'kurtas' },
      { ...makeResultItem('b'), colors: ['blue', 'white'], category: 'kurtas' },
      { ...makeResultItem('c'), colors: ['white'], category: 'dresses' },
    ];
    const facets = computeFacets(items);
    expect(facets.category.find((b) => b.value === 'kurtas')?.count).toBe(2);
    expect(facets.color.find((b) => b.value === 'blue')?.count).toBe(2);
    expect(facets.brand[0].label).toBe('Brand');
  });

  it('omits empty price bands', () => {
    const facets = computeFacets([{ ...makeResultItem('a'), price: 150_000 }]);
    expect(facets.price_band.every((b) => b.count > 0)).toBe(true);
  });

  it('maps a price band back to a range', () => {
    expect(priceBandRange('under-1000')).toEqual({ min: 0, max: 100_000 });
    expect(priceBandRange('nonsense')).toBeNull();
  });
});

// ============================================================ ingestion

describe('CSV parsing', () => {
  it('handles quoted fields with embedded commas and quotes', () => {
    const rows = parseCsvRows('a,b\n"x, y","he said ""hi"""\n');
    expect(rows[1]).toEqual(['x, y', 'he said "hi"']);
  });

  it('handles CRLF line endings', () => {
    expect(parseCsvRows('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('maps a product feed row', () => {
    const items = parseCsv(
      'id,title,price,url,image_url,colors,sizes\n1,Cotton Kurta,1999,https://x.in/p,https://x.in/i.jpg,blue|white,S|M\n',
    );
    expect(items).toHaveLength(1);
    expect(items[0].price_rupees).toBe(1999);
    expect(items[0].colors).toEqual(['blue', 'white']);
    expect(items[0].sizes).toEqual(['S', 'M']);
  });

  it('skips rows without a price or url', () => {
    expect(parseCsv('id,title,price,url\n1,No Price,,https://x.in/p\n')).toHaveLength(0);
  });
});

describe('Shopify parsing', () => {
  const product = (id: number) => ({
    id,
    handle: `item-${id}`,
    title: `Cotton Kurta ${id}`,
    product_type: 'Kurta',
    variants: [{ price: '1999', available: true }],
    images: [{ src: `https://cdn.shopify.com/item-${id}.jpg` }],
  });

  it('takes the lowest variant price and highest compare-at as MRP', () => {
    const items = parseShopify(
      JSON.stringify({
        products: [
          {
            id: 1,
            handle: 'kurta',
            title: 'Cotton Kurta',
            product_type: 'Kurta',
            variants: [
              { price: '2499', compare_at_price: '3499', available: true, option1: 'S' },
              { price: '1999', compare_at_price: '2999', available: false, option1: 'M' },
            ],
            images: [{ src: 'https://cdn.shopify.com/a.jpg' }],
            options: [{ name: 'Size', values: ['S', 'M'] }],
          },
        ],
      }),
      'https://brand.example.in',
    );
    expect(items[0].price_rupees).toBe(1999);
    expect(items[0].mrp_rupees).toBe(3499);
    expect(items[0].sizes).toEqual(['S', 'M']);
    expect(items[0].url).toBe('https://brand.example.in/products/kurta');
    expect(items[0].availability).toBe('in_stock');
  });

  it('marks a product out of stock when no variant is available', () => {
    const items = parseShopify(
      JSON.stringify({
        products: [
          {
            id: 2,
            handle: 'x',
            title: 'X',
            variants: [{ price: '100', available: false }],
            images: [{ src: 'https://cdn.shopify.com/a.jpg' }],
          },
        ],
      }),
      'https://b.in',
    );
    expect(items[0].availability).toBe('out_of_stock');
  });

  it('fetches every Shopify products.json page and preserves existing query parameters', async () => {
    const bodies = [
      JSON.stringify({ products: Array.from({ length: SHOPIFY_PAGE_SIZE }, (_, i) => product(i + 1)) }),
      JSON.stringify({ products: [product(SHOPIFY_PAGE_SIZE + 1)] }),
    ];
    const requested: URL[] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const href =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(href);
      requested.push(url);
      const page = Number(url.searchParams.get('page'));
      return new Response(bodies[page - 1] ?? JSON.stringify({ products: [] }));
    });

    try {
      const result = await fetchFeed('https://brand.example.in/products.json?view=public', 'shopify');
      expect(result.items).toHaveLength(SHOPIFY_PAGE_SIZE + 1);
      expect(result.items.at(-1)?.external_id).toBe(String(SHOPIFY_PAGE_SIZE + 1));
      expect(result.bytes).toBe(
        bodies.reduce((sum, body) => sum + new TextEncoder().encode(body).byteLength, 0),
      );
      expect(requested).toHaveLength(2);
      expect(requested[0].searchParams.get('view')).toBe('public');
      expect(requested[0].searchParams.get('limit')).toBe(String(SHOPIFY_PAGE_SIZE));
      expect(requested.map((url) => url.searchParams.get('page'))).toEqual(['1', '2']);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('refuses a partial catalogue when Shopify exceeds the fixed page/item budget', async () => {
    const body = JSON.stringify({
      products: Array.from({ length: SHOPIFY_PAGE_SIZE }, (_, i) => product(i + 1)),
    });
    let calls = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls++;
      return new Response(body);
    });

    try {
      await expect(fetchFeed('https://brand.example.in/products.json', 'shopify')).rejects.toThrow(
        'Shopify feed exceeds item limit',
      );
      expect(calls).toBe(SHOPIFY_MAX_PAGE_REQUESTS);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('enforces the aggregate byte budget across otherwise valid-sized pages', async () => {
    const description = 'x'.repeat(8_000);
    const body = JSON.stringify({
      products: Array.from({ length: SHOPIFY_PAGE_SIZE }, (_, id) => ({
        id,
        body_html: description,
        variants: [],
      })),
    });
    const pageBytes = new TextEncoder().encode(body).byteLength;
    let calls = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls++;
      return new Response(body);
    });

    try {
      await expect(fetchFeed('https://brand.example.in/products.json', 'shopify')).rejects.toThrow(
        'Shopify feed exceeds aggregate byte limit',
      );
      expect(calls).toBe(Math.floor(SHOPIFY_MAX_BYTES / pageBytes) + 1);
    } finally {
      fetchMock.mockRestore();
    }
  });
});

describe('The Souled Store collection adapter', () => {
  const listing = (page: number, totalPages: number, products: unknown[]) =>
    JSON.stringify({
      data: { listing: { products, pagination: { currentPage: page, totalPages } } },
    });

  const product = (id: number, artistSlug = 'harry-potter-official-merchandise') => ({
    id: String(id),
    product: `Harry Potter Tee ${id}`,
    artist: { name: 'Harry Potter™', slug: artistSlug },
    category: { name: 'Oversized T-Shirts' },
    price: 1499,
    genderType: 1,
    stock: 0,
    prodQty: id === 2 ? 0 : 12,
    splPrice: id === 1 ? 1299 : 0,
    images: [`item-${id}.jpg`],
    productSlug: `harry-potter-tee-${id}`,
  });

  it('maps public price, stock, image and destination without using the member-only price', () => {
    const parsed = parseSouledStoreListing(
      listing(1, 1, [product(1), product(2), product(3, 'another-artist')]),
      'harry-potter-official-merchandise',
    );

    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]).toMatchObject({
      external_id: '1',
      price_rupees: 1299,
      mrp_rupees: 1499,
      availability: 'in_stock',
      gender: 'men',
      url: 'https://www.thesouledstore.com/product/harry-potter-tee-1?gte=1',
      image_url:
        'https://prod-img.thesouledstore.com/public/theSoul/uploads/catalog/product/item-1.jpg',
    });
    expect(parsed.items[1].availability).toBe('out_of_stock');
    const normalised = normaliseItem(parsed.items[0]);
    expect(normalised.ok && normalised.item.category).toBe('tshirts');
  });

  it('fetches every collection page and rejects products outside the requested artist', async () => {
    const bodies = [listing(1, 2, [product(1)]), listing(2, 2, [product(2), product(3, 'other')])];
    const requests: { url: string; body: string; redirect?: string }[] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = String(init?.body ?? '');
      requests.push({ url, body, redirect: init?.redirect });
      return new Response(bodies[requests.length - 1]);
    });

    try {
      const result = await fetchFeed(
        'https://www.thesouledstore.com/artists/harry-potter-official-merchandise?utm_source=test',
        'souled_store',
      );
      expect(result.items.map((item) => item.external_id)).toEqual(['1', '2']);
      expect(requests).toHaveLength(2);
      expect(requests.every((request) => request.url === SOULED_STORE_API)).toBe(true);
      expect(requests.every((request) => request.redirect === 'manual')).toBe(true);
      expect(requests[0].body).toContain(`size: ${SOULED_STORE_PAGE_SIZE}`);
      expect(requests[1].body).toContain('page: 2');
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('only accepts a real Souled Store artist collection URL', async () => {
    await expect(
      fetchFeed('https://example.com/artists/harry-potter-official-merchandise', 'souled_store'),
    ).rejects.toThrow('must use thesouledstore.com');
    await expect(
      fetchFeed('https://www.thesouledstore.com/product/not-a-collection', 'souled_store'),
    ).rejects.toThrow('must be an /artists/:slug collection URL');
  });
});

describe('Google Merchant parsing', () => {
  it('extracts namespaced fields, CDATA and entities', () => {
    const items = parseGoogleMerchant(`<rss><channel><item>
      <g:id>SKU1</g:id>
      <title><![CDATA[Linen Shirt & Co]]></title>
      <link>https://b.in/p/1</link>
      <g:price>2499.00 INR</g:price>
      <g:image_link>https://b.in/i.jpg</g:image_link>
      <g:additional_image_link>https://b.in/i2.jpg</g:additional_image_link>
      <g:availability>in stock</g:availability>
      <g:color>Blue</g:color>
      <g:size>M</g:size>
      <g:size>L</g:size>
    </item></channel></rss>`);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Linen Shirt & Co');
    expect(items[0].price_rupees).toBe(2499);
    expect(items[0].sizes).toEqual(['M', 'L']);
    expect(items[0].images).toHaveLength(2);
  });
});

describe('SSRF guard', () => {
  it('rejects private and loopback targets', () => {
    expect(() => assertSafeUrl('https://localhost/feed.json')).toThrow();
    expect(() => assertSafeUrl('https://127.0.0.1/feed.json')).toThrow();
    expect(() => assertSafeUrl('https://10.1.2.3/feed.json')).toThrow();
    expect(() => assertSafeUrl('https://192.168.1.1/feed.json')).toThrow();
    expect(() => assertSafeUrl('https://169.254.169.254/latest/meta-data')).toThrow();
    expect(() => assertSafeUrl('https://foo.internal/feed')).toThrow();
  });

  it('rejects non-https', () => {
    expect(() => assertSafeUrl('http://brand.example.in/feed.json')).toThrow();
  });

  it('allows a normal storefront', () => {
    expect(assertSafeUrl('https://brand.example.in/products.json').hostname).toBe(
      'brand.example.in',
    );
  });
});

describe('rate-limit identity', () => {
  const fakeEnv = (): Env => {
    const values = new Map<string, string>();
    return {
      CACHE: {
        get: async (key: string) => values.get(key) ?? null,
        put: async (key: string, value: string) => {
          values.set(key, value);
        },
      },
    } as unknown as Env;
  };

  it('uses Cloudflare client IP plus session and never trusts spoofable forwarded-for', () => {
    const trusted = rateIdentity(
      new Request('https://vestiq.in/api/search', {
        headers: {
          'cf-connecting-ip': '203.0.113.42',
          'x-forwarded-for': '198.51.100.9',
        },
      }),
      'session-1',
    );
    expect(trusted).toEqual({ ip: '203.0.113.42', session: 'session-1' });

    const untrustedOnly = rateIdentity(
      new Request('https://vestiq.in/api/search', {
        headers: { 'x-forwarded-for': '198.51.100.9' },
      }),
      'session-2',
    );
    expect(untrustedOnly).toEqual({ ip: 'unknown', session: 'session-2' });
  });

  it('blocks cookie rotation at the shared IP budget', async () => {
    const env = fakeEnv();
    for (let i = 0; i < RULES.report.limit; i++) {
      const result = await rateLimit(env, 'report', { ip: '203.0.113.10', session: `rotated-${i}` });
      expect(result.ok).toBe(true);
    }
    const blocked = await rateLimit(env, 'report', {
      ip: '203.0.113.10',
      session: 'yet-another-cookie',
    });
    expect(blocked.ok).toBe(false);
  });

  it('retains the session budget when the client IP changes', async () => {
    const env = fakeEnv();
    for (let i = 0; i < RULES.report.limit; i++) {
      const result = await rateLimit(env, 'report', {
        ip: `203.0.113.${20 + i}`,
        session: 'same-session',
      });
      expect(result.ok).toBe(true);
    }
    const blocked = await rateLimit(env, 'report', {
      ip: '203.0.113.99',
      session: 'same-session',
    });
    expect(blocked.ok).toBe(false);
  });
});

describe('normaliseItem', () => {
  const valid = {
    external_id: '1',
    title: 'Block-printed Cotton Kurta Set',
    url: 'https://brand.fashion/p/1',
    image_url: 'https://brand.fashion/i.jpg',
    price_rupees: 2499,
    product_type: 'Kurta Set',
  };

  it('normalises a good row onto the canonical lexicon', () => {
    const result = normaliseItem(valid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.item.category).toBe('kurta-sets');
    expect(result.item.materials).toContain('cotton');
    expect(result.item.price).toBe(249_900);
    expect(result.item.gender).toBe('women');
  });

  it('rejects rows with an implausible price', () => {
    expect(normaliseItem({ ...valid, price_rupees: 3 })).toEqual({
      ok: false,
      reason: 'implausible_price',
    });
    expect(normaliseItem({ ...valid, price_rupees: 99_999_999 })).toEqual({
      ok: false,
      reason: 'implausible_price',
    });
  });

  it('rejects http and missing images', () => {
    expect(normaliseItem({ ...valid, url: 'http://brand.example.in/p' })).toEqual({
      ok: false,
      reason: 'bad_url',
    });
    expect(normaliseItem({ ...valid, image_url: undefined, images: [] })).toEqual({
      ok: false,
      reason: 'missing_image',
    });
  });

  it('rejects placeholder product destinations', () => {
    expect(normaliseItem({ ...valid, url: 'https://brand.example.in/p' })).toEqual({
      ok: false,
      reason: 'placeholder_url',
    });
  });

  it('rejects rows it cannot categorise', () => {
    const result = normaliseItem({ ...valid, title: 'Mystery Widget', product_type: 'Widget' });
    expect(result).toEqual({ ok: false, reason: 'unmappable_category' });
  });

  it('only treats compare-at as MRP when it exceeds price', () => {
    const lower = normaliseItem({ ...valid, mrp_rupees: 1000 });
    expect(lower.ok && lower.item.mrp).toBeNull();
    const higher = normaliseItem({ ...valid, mrp_rupees: 3999 });
    expect(higher.ok && higher.item.mrp).toBe(399_900);
  });

  it('strips HTML from descriptions', () => {
    const result = normaliseItem({ ...valid, description: '<p>Nice <b>kurta</b></p>' });
    expect(result.ok && result.item.description).toBe('Nice kurta');
  });

  it('normalises size tokens', () => {
    const result = normaliseItem({ ...valid, sizes: ['UK 8', 'Free Size', 'M', 'garbage'] });
    expect(result.ok && result.item.sizes).toEqual(expect.arrayContaining(['8', 'free', 'm']));
    expect(result.ok && result.item.sizes).not.toContain('garbage');
  });
});

describe('contentHash', () => {
  it('is stable for identical content and differs when price changes', async () => {
    const result = normaliseItem({
      external_id: '1',
      title: 'Cotton Kurta',
      url: 'https://b.in/p',
      image_url: 'https://b.in/i.jpg',
      price_rupees: 1999,
      product_type: 'Kurta',
    });
    if (!result.ok) throw new Error('fixture invalid');
    const a = await contentHash(result.item);
    const b = await contentHash({ ...result.item });
    const c = await contentHash({ ...result.item, price: 99_900 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('changes for every persisted catalogue field, including long-tail shopper details', async () => {
    const result = normaliseItem({
      external_id: 'hash-1',
      title: 'Cotton Kurta',
      description: 'a'.repeat(250),
      url: 'https://b.in/p',
      image_url: 'https://b.in/i.jpg',
      price_rupees: 1999,
      product_type: 'Kurta',
    });
    if (!result.ok) throw new Error('fixture invalid');
    const base = result.item;
    const hash = await contentHash(base);
    const mutations: Array<Partial<typeof base>> = [
      { external_id: 'hash-2' },
      { slug: 'changed-slug' },
      { title: 'Changed Cotton Kurta' },
      // The change is after character 200; the old truncated hash missed it.
      { description: `${base.description!.slice(0, -1)}z` },
      { category: 'dresses' },
      { subcategory: 'long-kurtas' },
      { gender: 'men' },
      { price: base.price + 100 },
      { mrp: 299_900 },
      { url: 'https://b.in/p-new' },
      { image_url: 'https://b.in/i-new.jpg' },
      { images: [...base.images, 'https://b.in/i-2.jpg'] },
      { colors: ['red'] },
      { sizes: ['m'] },
      { materials: [...base.materials, 'silk'] },
      { occasions: ['wedding'] },
      { style_tags: ['minimal'] },
      { attributes: { sleeve: 'long' } },
      { availability: 'out_of_stock' },
    ];

    for (const mutation of mutations) {
      expect(await contentHash({ ...base, ...mutation })).not.toBe(hash);
    }
  });

  it('canonicalises nested attribute key order', async () => {
    const result = normaliseItem({
      external_id: 'hash-order',
      title: 'Cotton Kurta',
      url: 'https://b.in/p',
      image_url: 'https://b.in/i.jpg',
      price_rupees: 1999,
      product_type: 'Kurta',
    });
    if (!result.ok) throw new Error('fixture invalid');

    const a = await contentHash({
      ...result.item,
      attributes: { fit: 'relaxed', measurements: { waist: 30, length: 42 } },
    });
    const b = await contentHash({
      ...result.item,
      attributes: { measurements: { length: 42, waist: 30 }, fit: 'relaxed' },
    });
    expect(a).toBe(b);
  });
});

describe('embedText', () => {
  it('produces concrete, visual text within the length cap', () => {
    const result = normaliseItem({
      external_id: '1',
      title: 'Block-printed Cotton Kurta',
      url: 'https://b.in/p',
      image_url: 'https://b.in/i.jpg',
      price_rupees: 1999,
      product_type: 'Kurta',
    });
    if (!result.ok) throw new Error('fixture invalid');
    const text = embedText(result.item, 'Kaanchi');
    expect(text).toContain('Kaanchi');
    expect(text).toContain('cotton');
    expect(text.length).toBeLessThanOrEqual(1200);
  });
});

// ============================================================ model output shapes

describe('coerceJsonObject', () => {
  /**
   * Regression guard. Workers AI returned `response` as an object, and the old
   * string-only extractor threw `text.trim is not a function`. The composite
   * caught it, so every search silently used the heuristic parser instead —
   * visible only as slightly worse relevance.
   */
  it('accepts an already-parsed object', async () => {
    const { coerceJsonObject } = await import('../src/ai/workers-ai');
    const obj = { semantic_text: 'linen shirt', intent: 'mood', confidence: 0.8 };
    expect(coerceJsonObject(obj)).toBe(obj);
  });

  it('parses a plain JSON string', async () => {
    const { coerceJsonObject } = await import('../src/ai/workers-ai');
    expect(coerceJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips markdown fences', async () => {
    const { coerceJsonObject } = await import('../src/ai/workers-ai');
    expect(coerceJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('recovers JSON wrapped in prose', async () => {
    const { coerceJsonObject } = await import('../src/ai/workers-ai');
    expect(coerceJsonObject('Sure! Here you go: {"a":1} Hope that helps.')).toEqual({ a: 1 });
  });

  it('returns null for unusable values instead of throwing', async () => {
    const { coerceJsonObject } = await import('../src/ai/workers-ai');
    for (const value of [null, undefined, '', '   ', 'not json at all', 42, true]) {
      expect(coerceJsonObject(value)).toBeNull();
    }
  });
});

// ============================================================ degenerate parses

describe('looksDegenerate', () => {
  /**
   * Regression guard. llama-3.1-8b copied the enum lists out of the system
   * prompt into its answer. Every value passed lexicon validation, so the parse
   * looked rich and confident while describing nothing — and it widened recall
   * across every category at once, which is worse than no AI parse at all.
   */
  it('rejects a parse that echoes the vocabulary prefix', async () => {
    const { looksDegenerate } = await import('../src/ai/provider');
    const { ALL_CATEGORIES, ALL_OCCASIONS } = await import('../src/ai/lexicon');
    expect(
      looksDegenerate({
        categories: ALL_CATEGORIES.slice(0, 8),
        occasions: ALL_OCCASIONS.slice(0, 8),
        style_tags: [],
        colors: [],
        materials: [],
      }),
    ).toBe(true);
  });

  it('rejects absurd breadth even when the values are not a prefix run', async () => {
    const { looksDegenerate } = await import('../src/ai/provider');
    expect(
      looksDegenerate({
        categories: ['sarees', 'heels', 'bags', 'jeans', 'blazers', 'kurtas'],
        occasions: [],
        style_tags: [],
        colors: [],
        materials: [],
      }),
    ).toBe(true);
  });

  it('accepts a normal, focused parse', async () => {
    const { looksDegenerate } = await import('../src/ai/provider');
    expect(
      looksDegenerate({
        categories: ['kurta-sets'],
        occasions: ['festive'],
        style_tags: ['traditional'],
        colors: ['blue'],
        materials: ['cotton'],
      }),
    ).toBe(false);
  });

  it('makes toParsedQuery fall back rather than return a degenerate parse', async () => {
    const { toParsedQuery } = await import('../src/ai/provider');
    const { ALL_CATEGORIES } = await import('../src/ai/lexicon');
    const seed = heuristicParse('cotton kurta');
    const out = toParsedQuery(
      {
        semantic_text: 'x',
        intent: 'mood',
        categories: ALL_CATEGORIES.slice(0, 8),
        confidence: 0.9,
      },
      seed,
      'test',
    );
    expect(out).toBeNull();
  });
});

describe('styling-problem intent is preserved over the model', () => {
  it('keeps the heuristic complements when the model reclassifies the query', async () => {
    const { toParsedQuery } = await import('../src/ai/provider');
    const seed = heuristicParse('what goes with wide-leg olive trousers');
    expect(seed.intent).toBe('styling_problem');

    const out = toParsedQuery(
      { semantic_text: 'olive trousers', intent: 'mood', categories: ['trousers'], confidence: 0.9 },
      seed,
      'test',
    );
    expect(out?.intent).toBe('styling_problem');
    // Must still be the complements to buy, not the trousers they already own.
    expect(out?.categories).not.toContain('trousers');
    expect(out?.categories).toContain('tops');
  });
});
