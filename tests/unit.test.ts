import { describe, expect, it } from 'vitest';
import {
  clamp,
  discountPct,
  esc,
  escJson,
  formatINR,
  ftsQuote,
  isBotUA,
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
  injectPromoted,
  matchReasons,
  MAX_PROMOTED_PER_PAGE,
  popularityFactor,
  tasteFactor,
  trustFactor,
} from '../src/search/rank';
import { buildFtsQuery } from '../src/search/lexical';
import { dot, packId, quantise, toSimilarity, unpackId, ID_WIDTH } from '../src/search/vector';
import { parseCsv, parseCsvRows, parseGoogleMerchant, parseShopify, assertSafeUrl } from '../src/ingest/adapters';
import { normaliseItem, contentHash, embedText } from '../src/ingest/normalize';
import { affiliateUrl } from '../src/routes/go';
import { computeFacets, priceBandRange } from '../src/search/facets';
import { toParsedQuery } from '../src/ai/provider';
import type { ParsedQuery, Product, ResultItem } from '../src/types';

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
    image_url: '/ph?s=x',
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

  it('keeps products with no size data rather than filtering them out', () => {
    // Missing size data is a feed gap, not evidence the size is unavailable.
    const result = applyFilters([makeProduct({ sizes: [] })], { ...base, sizes: ['xxl'] });
    expect(result.kept).toHaveLength(1);
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

function makeResultItem(id: string, promoted = false): ResultItem {
  return {
    ...makeProduct({ id }),
    brand_name: 'Brand',
    brand_slug: 'brand',
    brand_trust: 70,
    brand_ship_days: 3,
    score: 1,
    match_reasons: [],
    promoted,
  };
}

describe('promoted placement invariant (ADR-10)', () => {
  const organic = Array.from({ length: 24 }, (_, i) => makeResultItem(`o${i}`));

  it('never exceeds the promoted cap', () => {
    const promoted = Array.from({ length: 8 }, (_, i) => makeResultItem(`ad${i}`, true));
    const out = injectPromoted(organic, promoted, 24);
    expect(out.filter((i) => i.promoted)).toHaveLength(MAX_PROMOTED_PER_PAGE);
  });

  it('flags every promoted item so the renderer must label it', () => {
    const out = injectPromoted(organic, [makeResultItem('ad0', true)], 24);
    for (const item of out) {
      const isAd = item.id.startsWith('ad');
      expect(item.promoted).toBe(isAd);
    }
  });

  it('never lets the page grow beyond perPage', () => {
    const promoted = Array.from({ length: 4 }, (_, i) => makeResultItem(`ad${i}`, true));
    expect(injectPromoted(organic, promoted, 24)).toHaveLength(24);
  });

  it('does not duplicate a product that is already organic', () => {
    const out = injectPromoted(organic, [makeResultItem('o3', true)], 24);
    expect(out.filter((i) => i.id === 'o3')).toHaveLength(1);
  });

  it('is a no-op with no campaigns', () => {
    expect(injectPromoted(organic, [], 24)).toEqual(organic);
  });

  it('does not inject into a short result page beyond its length', () => {
    const short = [makeResultItem('a'), makeResultItem('b')];
    const out = injectPromoted(short, [makeResultItem('ad', true)], 24);
    expect(out.length).toBeLessThanOrEqual(3);
  });
});

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

describe('normaliseItem', () => {
  const valid = {
    external_id: '1',
    title: 'Block-printed Cotton Kurta Set',
    url: 'https://brand.example.in/p/1',
    image_url: 'https://brand.example.in/i.jpg',
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

// ============================================================ outbound links

describe('affiliateUrl', () => {
  it('returns the raw URL when no template is configured', () => {
    expect(affiliateUrl('https://b.in/p', null)).toBe('https://b.in/p');
  });

  it('substitutes into a template', () => {
    expect(affiliateUrl('https://b.in/p', 'https://track.example/?u={url}')).toBe(
      'https://track.example/?u=https%3A%2F%2Fb.in%2Fp',
    );
  });

  it('ignores a template that is not a valid https URL', () => {
    expect(affiliateUrl('https://b.in/p', 'javascript:alert(1){url}')).toBe('https://b.in/p');
    expect(affiliateUrl('https://b.in/p', 'not a url {url}')).toBe('https://b.in/p');
  });

  it('ignores a template with no placeholder', () => {
    expect(affiliateUrl('https://b.in/p', 'https://track.example/')).toBe('https://b.in/p');
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
