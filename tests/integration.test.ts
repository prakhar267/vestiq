import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { env, migrate, seedBrand, seedProduct } from './helpers';
import { sha256Hex } from '../src/lib/util';
import { resolveReferenceProfile } from '../src/search';

const ADMIN_TOKEN = 'test-admin-token-at-least-16-chars';

let brandId: string;
let kurtaId: string;
let expensiveId: string;
let xssId: string;

beforeAll(async () => {
  await migrate();

  brandId = await seedBrand({ name: 'Kaanchi', slug: 'kaanchi', trust: 82 });

  kurtaId = await seedProduct(brandId, {
    title: 'Block-printed Cotton Kurta Set',
    category: 'kurta-sets',
    price: 199_900,
    mrp: 299_900,
    colors: ['blue'],
    materials: ['cotton'],
    occasions: ['festive'],
    sizes: ['s', 'm', 'l'],
  });

  expensiveId = await seedProduct(brandId, {
    title: 'Hand-embroidered Silk Lehenga',
    category: 'lehengas',
    price: 4_500_000,
    colors: ['red'],
    materials: ['silk'],
    occasions: ['wedding'],
  });

  // A hostile listing: merchant-supplied text is untrusted input.
  xssId = await seedProduct(brandId, {
    title: '<script>alert("xss")</script> Cotton Dress',
    category: 'dresses',
    price: 149_900,
    colors: ['white'],
    materials: ['cotton'],
  });

  await seedProduct(brandId, {
    title: 'Linen Wide-leg Trousers',
    category: 'trousers',
    price: 249_900,
    colors: ['olive'],
    materials: ['linen'],
    occasions: ['work'],
  });
});

// ============================================================ health

describe('brand-reference profile', () => {
  it('derives an indexed brand aesthetic from real catalogue attributes', async () => {
    const profile = await resolveReferenceProfile(env, ['Kaanchi']);
    expect(profile).not.toBeNull();
    expect(profile?.categories).toContain('kurta-sets');
    expect(profile?.materials).toContain('cotton');
    expect(profile?.text).toContain('Kaanchi');
  });
});

describe('GET /health', () => {
  it('reports healthy with per-component checks', async () => {
    const res = await SELF.fetch('http://localhost/health');
    expect(res.status).toBe(200);
    const body = await res.json<{
      status: string;
      checks: Record<string, { ok: boolean; note?: string }>;
    }>();
    expect(body.status).toBe('healthy');
    expect(body.checks.d1.ok).toBe(true);
    expect(body.checks.kv_cache.ok).toBe(true);
    expect(body.checks.admin_configured.ok).toBe(true);
    expect(body.checks.catalogue_integrity.ok).toBe(true);
    expect(body.checks.catalogue_ready.ok).toBe(true);
  });

  it('separates operational readiness from liveness', async () => {
    const res = await SELF.fetch('http://localhost/ready');
    expect(res.status).toBe(503);
    const body = await res.json<{ status: string; checks: Record<string, { ok: boolean }> }>();
    expect(body.status).toBe('not_ready');
    expect(body.checks.real_inventory.ok).toBe(true);
    expect(body.checks.email_delivery.ok).toBe(false);
  });

  it('is never cached', async () => {
    const res = await SELF.fetch('http://localhost/health');
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('declares the AI provider chain, including the degraded case', async () => {
    // No AI binding and no Gemini key in tests, so this must report degraded
    // rather than claiming health (ADR-5).
    const body = await (await SELF.fetch('http://localhost/health')).json<{
      checks: { ai: { ok: boolean; note?: string } };
    }>();
    expect(body.checks.ai.note).toContain('heuristic');
  });
});

// ============================================================ shell & security

describe('security headers', () => {
  it('sets a strict CSP with a per-request nonce and no unsafe-inline scripts', async () => {
    const res = await SELF.fetch('http://localhost/');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9]+'/);
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it('issues a fresh nonce per request', async () => {
    const [a, b] = await Promise.all([
      SELF.fetch('http://localhost/'),
      SELF.fetch('http://localhost/'),
    ]);
    const nonceOf = (res: Response) =>
      /nonce-([A-Za-z0-9]+)/.exec(res.headers.get('content-security-policy') ?? '')?.[1];
    expect(nonceOf(a)).toBeTruthy();
    expect(nonceOf(a)).not.toBe(nonceOf(b));
  });

  it('sets the standard hardening headers', async () => {
    const res = await SELF.fetch('http://localhost/');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('strict-transport-security')).toContain('max-age=');
  });

  it('sets an httpOnly session cookie', async () => {
    const res = await SELF.fetch('http://localhost/');
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('vq_sid=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
  });
});

describe('GET /', () => {
  it('server-renders the homepage with the search form and JSON-LD', async () => {
    const res = await SELF.fetch('http://localhost/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('vestiq');
    // SEO is the primary channel: content must be in the first byte, not hydrated.
    expect(html).toContain('<form action="/search" method="GET"');
    expect(html).toContain('"@type":"WebSite"');
    expect(html).toContain('"SearchAction"');
    expect(html).toContain('rel="canonical"');
    expect(html).toContain('type="search"');
    expect(html).toContain('Kurta sets');
    expect(html).not.toContain('matching co-ord set for a Goa vacation');
  });

  it('renders the free-launch purchase disclosure without monetisation claims', async () => {
    const html = await (await SELF.fetch('http://localhost/')).text();
    expect(html).toContain('free for shoppers and brands during launch');
    expect(html).toContain("purchases happen on each brand's own website");
    expect(html).not.toMatch(/commission|paid placement|promoted/i);
  });
});

// ============================================================ search

describe('GET /search', () => {
  it('finds a product by its attributes and renders it server-side', async () => {
    const html = await (
      await SELF.fetch('http://localhost/search?q=cotton%20kurta%20set')
    ).text();
    expect(html).toContain('Block-printed Cotton Kurta Set');
    expect(html).toContain('₹1,999');
  });

  it('shows what the query was understood as', async () => {
    const html = await (
      await SELF.fetch('http://localhost/search?q=cotton%20kurta%20under%20%E2%82%B93000')
    ).text();
    expect(html).toContain('Understood as');
    expect(html).toContain('data-drop=');
  });

  it('applies a price ceiling from natural language', async () => {
    const html = await (
      await SELF.fetch('http://localhost/search?q=lehenga%20under%20%E2%82%B95000')
    ).text();
    // The ₹45,000 lehenga must not appear under a ₹5,000 budget.
    expect(html).not.toContain('Hand-embroidered Silk Lehenga');
  });

  it('escapes hostile merchant text rather than rendering it', async () => {
    const html = await (await SELF.fetch('http://localhost/search?q=cotton%20dress')).text();
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert("xss")</script>');
  });

  it('renders a designed empty state with relaxations, not a dead end', async () => {
    const html = await (
      await SELF.fetch('http://localhost/search?q=cotton%20kurta%20under%20%E2%82%B910')
    ).text();
    expect(html).toContain('Nothing matched that');
    expect(html).toMatch(/Raise budget|Any size|Any fabric|All /);
    expect(html).toContain('Browse live pieces');
  });

  it('survives FTS5 operator injection in the query', async () => {
    for (const query of ['kurta NEAR/2 x', 'a" OR "b', 'cotton*', '(((', 'NOT NOT']) {
      const res = await SELF.fetch(`http://localhost/search?q=${encodeURIComponent(query)}`);
      expect(res.status).toBe(200);
    }
  });

  it('survives SQL metacharacters in the query', async () => {
    const res = await SELF.fetch(
      `http://localhost/search?q=${encodeURIComponent("'; DROP TABLE vestiq_products; --")}`,
    );
    expect(res.status).toBe(200);
    // The table must still be there.
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM vestiq_products').first<{ n: number }>();
    expect(Number(row?.n)).toBeGreaterThan(0);
  });

  it('noindexes thin result pages', async () => {
    const html = await (
      await SELF.fetch('http://localhost/search?q=hand-embroidered%20silk%20lehenga')
    ).text();
    expect(html).toContain('name="robots" content="noindex');
  });

  it('renders real pagination links so it works without JS', async () => {
    const html = await (await SELF.fetch('http://localhost/search?q=cotton')).text();
    expect(html).toMatch(/<form action="\/search" method="GET">/);
    expect(html).toContain('Apply filters');
  });

  it('respects an explicit price sort', async () => {
    const html = await (
      await SELF.fetch('http://localhost/search?q=cotton&sort=price_asc')
    ).text();
    const cheapAt = html.indexOf('₹1,499');
    const dearAt = html.indexOf('₹1,999');
    expect(cheapAt).toBeGreaterThan(-1);
    expect(cheapAt).toBeLessThan(dearAt);
  });

  it('shows the search page without a query, and noindexes it', async () => {
    const res = await SELF.fetch('http://localhost/search');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('What are you looking for?');
    expect(html).toContain('noindex');
  });
});

describe('embedding storage', () => {
  /**
   * Regression guard. Binding an Int8Array to a D1 BLOB column does not store
   * bytes — it coerces the typed array to its string form and stores TEXT. The
   * row looks written, `embed_version` looks correct, and the vector is garbage;
   * the only symptom was semantic search silently never working.
   */
  it('stores a quantised vector as a real BLOB, not TEXT', async () => {
    const { quantise } = await import('../src/search/vector');
    const { toInt8Vector } = await import('../src/jobs');

    const vec = quantise(new Float32Array(Array.from({ length: 384 }, (_, i) => (i % 7) - 3)));
    const blob = vec.buffer.slice(vec.byteOffset, vec.byteOffset + vec.byteLength);

    await env.DB.prepare(`UPDATE vestiq_products SET embedding = ?, embed_version = 1 WHERE id = ?`)
      .bind(blob, kurtaId)
      .run();

    const stored = await env.DB.prepare(
      `SELECT typeof(embedding) AS t, length(embedding) AS len FROM vestiq_products WHERE id = ?`,
    )
      .bind(kurtaId)
      .first<{ t: string; len: number }>();

    expect(stored?.t).toBe('blob');
    expect(stored?.len).toBe(384);

    const readBack = await env.DB.prepare(`SELECT embedding FROM vestiq_products WHERE id = ?`)
      .bind(kurtaId)
      .first<{ embedding: unknown }>();
    const restored = toInt8Vector(readBack?.embedding, 384);
    expect(restored).not.toBeNull();
    expect(Array.from(restored!)).toEqual(Array.from(vec));
  });

  it('rejects vectors of the wrong length instead of padding them', async () => {
    const { toInt8Vector } = await import('../src/jobs');
    expect(toInt8Vector(new ArrayBuffer(100), 384)).toBeNull();
    expect(toInt8Vector([1, 2, 3], 384)).toBeNull();
    expect(toInt8Vector(null, 384)).toBeNull();
    expect(toInt8Vector('1,2,3', 384)).toBeNull();
  });

  it('restores signed values from every representation D1 may return', async () => {
    const { toInt8Vector } = await import('../src/jobs');
    const source = new Int8Array([-128, -1, 0, 1, 127]);
    const dim = source.length;

    const fromBuffer = toInt8Vector(source.buffer, dim);
    const fromView = toInt8Vector(source, dim);
    // Unsigned byte array, as some drivers return.
    const fromArray = toInt8Vector([128, 255, 0, 1, 127], dim);
    const fromString = toInt8Vector('-128,-1,0,1,127', dim);

    for (const candidate of [fromBuffer, fromView, fromArray, fromString]) {
      expect(candidate).not.toBeNull();
      expect(Array.from(candidate!)).toEqual([-128, -1, 0, 1, 127]);
    }
  });
});

describe('lexical (FTS5) arm', () => {
  /**
   * Regression guard. `bm25()` requires the real table name; with an alias it
   * throws "no such column", which the resilience catch swallowed — silently
   * disabling lexical recall entirely while search still appeared to work via
   * the structured arm. This asserts the arm actually returns ranked rows.
   */
  it('returns bm25-ranked hits (not a swallowed SQL error)', async () => {
    const { lexicalSearch } = await import('../src/search/lexical');
    const { heuristicParse } = await import('../src/ai/heuristic');

    const hits = await lexicalSearch(env, heuristicParse('cotton'), 50);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => Number.isFinite(h.score))).toBe(true);
    // Descending relevance after the sign flip.
    expect(hits[0].score).toBeGreaterThanOrEqual(hits[hits.length - 1].score);
  });

  it('finds a product by a word that only appears in its title', async () => {
    const { lexicalSearch } = await import('../src/search/lexical');
    const { heuristicParse } = await import('../src/ai/heuristic');
    const hits = await lexicalSearch(env, heuristicParse('lehenga'), 50);
    expect(hits.map((h) => h.id)).toContain(expensiveId);
  });

  it('excludes out-of-stock products from lexical recall', async () => {
    const gone = await seedProduct(brandId, {
      title: 'Discontinued Cotton Thing',
      category: 'tops',
      availability: 'out_of_stock',
    });
    const { lexicalSearch } = await import('../src/search/lexical');
    const { heuristicParse } = await import('../src/ai/heuristic');
    const hits = await lexicalSearch(env, heuristicParse('discontinued'), 50);
    expect(hits.map((h) => h.id)).not.toContain(gone);
  });
});

describe('GET /api/search', () => {
  it('returns JSON with the parse and items', async () => {
    const res = await SELF.fetch('http://localhost/api/search?q=cotton');
    expect(res.status).toBe(200);
    const body = await res.json<{ items: unknown[]; parse: { intent: string }; total: number }>();
    expect(body.total).toBeGreaterThan(0);
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.parse.intent).toBeTruthy();
  });

  it('rejects a missing query', async () => {
    expect((await SELF.fetch('http://localhost/api/search')).status).toBe(400);
  });

  it('returns ready-to-insert HTML for the infinite-scroll island', async () => {
    const res = await SELF.fetch('http://localhost/api/search?q=cotton&format=html');
    const body = await res.json<{ html: string; has_more: boolean }>();
    expect(body.html).toContain('class="grid"');
    expect(typeof body.has_more).toBe('boolean');
  });
});

// ============================================================ product detail

describe('GET /p/:handle', () => {
  it('renders the PDP with Product JSON-LD and an outbound CTA', async () => {
    const slug = 'block-printed-cotton-kurta-set';
    const res = await SELF.fetch(`http://localhost/p/${slug}-${kurtaId}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('"@type":"Product"');
    expect(html).toContain('"priceCurrency":"INR"');
    expect(html).toContain('"BreadcrumbList"');
    expect(html).toContain(`/go/${kurtaId}`);
    // `sponsored` would be a false declaration to search engines: the free launch
    // has no affiliate or paid relationship with the brand.
    expect(html).toContain('rel="nofollow noopener"');
    expect(html).not.toContain('sponsored');
    expect(html).toMatch(/View on\s+Kaanchi/);
  });

  it('redirects a stale slug to the canonical URL', async () => {
    const res = await SELF.fetch(`http://localhost/p/old-wrong-slug-${kurtaId}`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(
      `/p/block-printed-cotton-kurta-set-${kurtaId}`,
    );
  });

  it('404s an unknown product', async () => {
    expect((await SELF.fetch('http://localhost/p/nope-p_doesnotexist')).status).toBe(404);
  });

  it('surfaces trust signals above the outbound CTA', async () => {
    const html = await (
      await SELF.fetch(`http://localhost/p/block-printed-cotton-kurta-set-${kurtaId}`)
    ).text();
    expect(html).toContain('Brand trust');
    expect(html).toContain('Price checked');
  });
});

// ============================================================ outbound clicks

describe('GET /go/:id', () => {
  it('redirects to the merchant and records the click', async () => {
    const res = await SELF.fetch(`http://localhost/go/${kurtaId}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^https:\/\/[a-z0-9-]+\.fashion\/products\//);

    // waitUntil work is flushed by the pool before assertions resolve.
    const row = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM vestiq_clicks WHERE product_id = ?',
    )
      .bind(kurtaId)
      .first<{ n: number }>();
    expect(Number(row?.n)).toBeGreaterThan(0);
  });

  it('never honours a user-supplied destination', async () => {
    // There is deliberately no ?url= parameter; an attacker-controlled query
    // must not influence the redirect target.
    const res = await SELF.fetch(
      `http://localhost/go/${kurtaId}?url=https://evil.example/phish`,
      { redirect: 'manual' },
    );
    expect(res.headers.get('location')).not.toContain('evil.example');
  });

  it('sends unknown products home rather than erroring', async () => {
    const res = await SELF.fetch('http://localhost/go/p_nonexistent', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/?e=gone');
  });
});

// ============================================================ saves

describe('POST /api/save', () => {
  it('saves and unsaves against the anonymous session', async () => {
    const first = await SELF.fetch('http://localhost/');
    const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0];

    const save = await SELF.fetch('http://localhost/api/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ product_id: kurtaId, saved: true }),
    });
    expect(save.status).toBe(200);

    const wardrobe = await SELF.fetch('http://localhost/wardrobe', { headers: { cookie } });
    expect(await wardrobe.text()).toContain('Block-printed Cotton Kurta Set');

    await SELF.fetch('http://localhost/api/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ product_id: kurtaId, saved: false }),
    });
    const after = await SELF.fetch('http://localhost/wardrobe', { headers: { cookie } });
    expect(await after.text()).not.toContain('Block-printed Cotton Kurta Set');
  });

  it('rejects a save for a product that does not exist', async () => {
    const res = await SELF.fetch('http://localhost/api/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ product_id: 'p_fake', saved: true }),
    });
    expect(res.status).toBe(404);
  });

  it('rejects a malformed body', async () => {
    const res = await SELF.fetch('http://localhost/api/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nope: true }),
    });
    expect(res.status).toBe(400);
  });
});

// ============================================================ alerts

describe('POST /api/alert', () => {
  it('refuses to arm an alert with no delivery channel', async () => {
    // An anonymous shopper has no email on file, and an armed alert the
    // dispatcher could never notify is worse than no alert: the shopper believes
    // they are being watched for. So the API asks for an address instead.
    const res = await SELF.fetch('http://localhost/api/alert', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ product_id: kurtaId, kind: 'price_drop' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; needs_email: boolean }>();
    expect(body.ok).toBe(false);
    expect(body.needs_email).toBe(true);

    const row = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM vestiq_alerts WHERE product_id = ?',
    )
      .bind(kurtaId)
      .first<{ n: number }>();
    expect(Number(row?.n)).toBe(0);
  });

  it('arms a price-drop alert once an email is supplied', async () => {
    const res = await SELF.fetch('http://localhost/api/alert', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        product_id: kurtaId,
        kind: 'price_drop',
        email: 'shopper@example.in',
        target_rupees: 1500,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; needs_email: boolean }>();
    expect(body.ok).toBe(true);
    expect(body.needs_email).toBe(false);

    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
    const row = await env.DB.prepare(
      `SELECT id, kind, status, email, target_price, base_price
       FROM vestiq_alerts WHERE product_id = ?`,
    )
      .bind(kurtaId)
      .first<{ id: string; kind: string; status: string; email: string; target_price: number; base_price: number }>();
    expect(row?.status).toBe('armed');
    expect(row?.email).toBe('shopper@example.in');
    // Rupees in, paise stored.
    expect(row?.target_price).toBe(150_000);
    expect(row?.base_price).toBe(199_900);

    const cancelled = await SELF.fetch('http://localhost/api/alert/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ alert_id: row?.id }),
    });
    expect(cancelled.status).toBe(200);
    const after = await env.DB.prepare(`SELECT status FROM vestiq_alerts WHERE id = ?`)
      .bind(row?.id)
      .first<{ status: string }>();
    expect(after?.status).toBe('cancelled');
  });

  it('rejects an invalid alert kind', async () => {
    const res = await SELF.fetch('http://localhost/api/alert', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ product_id: kurtaId, kind: 'telepathy' }),
    });
    expect(res.status).toBe(400);
  });
});

// ============================================================ rate limiting

describe('rate limiting', () => {
  it('blocks with 429 and Retry-After once the report budget is spent', async () => {
    const first = await SELF.fetch('http://localhost/');
    const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0];

    const send = () =>
      SELF.fetch('http://localhost/api/report', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ product_id: kurtaId, reason: 'dead_link' }),
      });

    let sawLimit = false;
    // The report rule allows 5 per hour.
    for (let i = 0; i < 9; i++) {
      const res = await send();
      if (res.status === 429) {
        sawLimit = true;
        expect(res.headers.get('retry-after')).toBeTruthy();
        break;
      }
    }
    expect(sawLimit).toBe(true);
  });
});

// ============================================================ admin

describe('/admin', () => {
  it('redirects an unauthenticated visitor to the login page', async () => {
    const res = await SELF.fetch('http://localhost/admin/queries', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/login');
  });

  it('rejects a wrong token', async () => {
    const res = await SELF.fetch('http://localhost/admin/queries', {
      headers: { authorization: 'Bearer wrong-token-wrong-token' },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
  });

  it('serves the overview with a valid bearer token', async () => {
    const res = await SELF.fetch('http://localhost/admin', {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Live SKUs');
    expect(html).toContain('Zero-result');
  });

  it('never lets admin pages be indexed', async () => {
    const html = await (
      await SELF.fetch('http://localhost/admin', {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      })
    ).text();
    expect(html).toContain('noindex');
  });

  it('exposes the query-gap report', async () => {
    await SELF.fetch('http://localhost/search?q=something%20we%20definitely%20lack%20xyzzy');
    const html = await (
      await SELF.fetch('http://localhost/admin/queries', {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      })
    ).text();
    expect(html).toContain('Query gaps');
  });

  it('refuses to approve a placeholder-domain brand', async () => {
    const id = await seedBrand({ name: 'Fixture Merchant', slug: 'fixture-merchant', status: 'pending' });
    await seedProduct(id, { title: 'Fixture Merchant Dress', category: 'dresses' });
    await env.DB.prepare(`UPDATE vestiq_brands SET domain = 'fixture.example.in' WHERE id = ?`).bind(id).run();
    const res = await SELF.fetch(`http://localhost/admin/brands/${id}/status`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ status: 'active' }),
      redirect: 'manual',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')?.toLowerCase()).toContain('placeholder');
    const brand = await env.DB.prepare(`SELECT status FROM vestiq_brands WHERE id = ?`)
      .bind(id)
      .first<{ status: string }>();
    expect(brand?.status).toBe('pending');
  });
});

// ============================================================ merchant

describe('/merchant', () => {
  it('requires a key for the dashboard', async () => {
    const res = await SELF.fetch('http://localhost/merchant', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/merchant/login');
  });

  it('creates a brand and shows the API key exactly once', async () => {
    const body = new URLSearchParams({
      brand_name: 'Test Signup Label',
      store_url: 'https://testsignup.fashion',
      email: 'founder@testsignup.fashion',
      city: 'Jaipur',
    });
    const res = await SELF.fetch('http://localhost/merchant/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    expect(res.status).toBe(201);
    const html = await res.text();
    expect(html).toMatch(/vq_[a-z0-9]{32}/);
    expect(html).toContain('pending review');

    // Only the hash is persisted.
    const row = await env.DB.prepare(
      `SELECT api_key_hash, feed_url FROM vestiq_merchants WHERE email = ?`,
    )
      .bind('founder@testsignup.fashion')
      .first<{ api_key_hash: string; feed_url: string }>();
    expect(row?.api_key_hash).toMatch(/^[0-9a-f]{64}$/);
    // Shopify feed is guessed so onboarding needs no developer work.
    expect(row?.feed_url).toBe('https://testsignup.fashion/products.json');

    // New brands must not be live until reviewed.
    const brand = await env.DB.prepare(
      `SELECT status FROM vestiq_brands WHERE name = ?`,
    )
      .bind('Test Signup Label')
      .first<{ status: string }>();
    expect(brand?.status).toBe('pending');
  });

  it('rejects a duplicate email', async () => {
    const make = () =>
      SELF.fetch('http://localhost/merchant/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          brand_name: 'Dup Label',
          store_url: 'https://dup.fashion',
          email: 'dup@dup.fashion',
        }),
      });
    await make();
    expect((await make()).status).toBe(409);
  });

  it('rejects a non-https store URL', async () => {
    const res = await SELF.fetch('http://localhost/merchant/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        brand_name: 'Insecure',
        store_url: 'http://insecure.fashion',
        email: 'a@insecure.fashion',
      }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects placeholder merchant domains', async () => {
    const res = await SELF.fetch('http://localhost/merchant/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        brand_name: 'Placeholder Label',
        store_url: 'https://placeholder.example.in',
        email: 'owner@placeholder.invalid',
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('real public');
  });

  it('reports account email as unavailable when Resend is not configured', async () => {
    const res = await SELF.fetch('http://localhost/account/request', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'shopper@example.in' }),
    });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('isn’t configured');
  });
});

// ============================================================ shopper account

describe('passwordless shopper account', () => {
  it('consumes a one-time token and merges anonymous saved state', async () => {
    const first = await SELF.fetch('http://localhost/');
    const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0];
    const saved = await SELF.fetch('http://localhost/api/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ product_id: kurtaId, saved: true }),
    });
    expect(saved.status).toBe(200);

    const token = 'a'.repeat(48);
    await env.DB.prepare(
      `INSERT INTO vestiq_auth_tokens (id, email, token_hash, expires_at, created_at) VALUES (?,?,?,?,?)`,
    )
      .bind('at_account_test', 'cross-device@example.in', await sha256Hex(token), Date.now() + 60_000, Date.now())
      .run();

    const verified = await SELF.fetch(`http://localhost/account/verify?token=${token}`, {
      headers: { cookie },
      redirect: 'manual',
    });
    expect(verified.status).toBe(303);
    expect(verified.headers.get('location')).toContain('/wardrobe');

    const user = await env.DB.prepare(`SELECT id FROM vestiq_users WHERE email = ?`)
      .bind('cross-device@example.in')
      .first<{ id: string }>();
    expect(user?.id).toBeTruthy();
    const merged = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM vestiq_saves WHERE owner_key = ? AND product_id = ?`,
    )
      .bind(`u:${user?.id}`, kurtaId)
      .first<{ n: number }>();
    expect(Number(merged?.n)).toBe(1);

    const replay = await SELF.fetch(`http://localhost/account/verify?token=${token}`, {
      headers: { cookie },
    });
    expect(replay.status).toBe(400);
  });
});

// ============================================================ SEO surfaces

describe('SEO', () => {
  it('serves robots.txt pointing at the sitemap and blocking faceted URLs', async () => {
    const body = await (await SELF.fetch('http://localhost/robots.txt')).text();
    expect(body).toContain('Sitemap:');
    expect(body).toContain('Disallow: /api/');
    expect(body).toContain('Disallow: /go/');
    expect(body).toContain('Disallow: /search?*brand=');
  });

  it('serves a valid sitemap index', async () => {
    const res = await SELF.fetch('http://localhost/sitemap.xml');
    expect(res.headers.get('content-type')).toContain('application/xml');
    const xml = await res.text();
    expect(xml).toContain('<sitemapindex');
    expect(xml).toContain('sitemap-products/1.xml');
  });

  it('lists seeded products in the product sitemap', async () => {
    const xml = await (await SELF.fetch('http://localhost/sitemap-products/1.xml')).text();
    expect(xml).toContain('<urlset');
    expect(xml).toContain(kurtaId);
  });

  it('excludes hidden products and products owned by inactive brands', async () => {
    const inactiveBrand = await seedBrand({
      name: 'Inactive Sitemap Label',
      slug: 'inactive-sitemap-label',
      status: 'inactive',
    });
    const inactiveProduct = await seedProduct(inactiveBrand, {
      title: 'Inactive Brand Sitemap Coat',
    });
    const hiddenProduct = await seedProduct(brandId, {
      title: 'Hidden Sitemap Coat',
      status: 'hidden',
    });

    const xml = await (await SELF.fetch('http://localhost/sitemap-products/1.xml')).text();
    expect(xml).not.toContain(inactiveProduct);
    expect(xml).not.toContain(hiddenProduct);
  });

  it('excludes non-indexable collections from the sitemap', async () => {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO vestiq_collections
        (id, slug, title, kind, filters, product_ids, item_count, indexable, status, created_at, updated_at)
       VALUES ('col_thin','thin-edit','Thin Edit','auto','{}','[]',3,0,'active',?,?)`,
    )
      .bind(Date.now(), Date.now())
      .run();
    const xml = await (await SELF.fetch('http://localhost/sitemap-collections.xml')).text();
    expect(xml).not.toContain('thin-edit');
  });

  it('serves opensearch and the web manifest', async () => {
    expect((await SELF.fetch('http://localhost/opensearch.xml')).status).toBe(200);
    expect((await SELF.fetch('http://localhost/manifest.webmanifest')).status).toBe(200);
  });

  it('does not expose the old invented placeholder endpoint', async () => {
    expect((await SELF.fetch('http://localhost/ph?s=abc')).status).toBe(404);
  });
});

describe('/img proxy', () => {
  it('refuses hosts that are not onboarded brands', async () => {
    const res = await SELF.fetch(
      `http://localhost/img?w=480&u=${encodeURIComponent('https://evil.example/tracker.png')}`,
    );
    expect(res.status).toBe(403);
  });

  it('refuses non-https and malformed URLs', async () => {
    expect(
      (await SELF.fetch(`http://localhost/img?u=${encodeURIComponent('http://x.in/a.png')}`)).status,
    ).toBe(400);
    expect((await SELF.fetch('http://localhost/img?u=not-a-url')).status).toBe(400);
    expect((await SELF.fetch('http://localhost/img')).status).toBe(400);
  });

  it('refuses redirects from an allowlisted image host to an unsafe destination', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'https://evil.example/redirected-tracker.png' },
      }),
    );

    try {
      const target = 'https://cdn.shopify.com/unsafe-redirect-regression.png';
      const res = await SELF.fetch(
        `http://localhost/img?u=${encodeURIComponent(target)}`,
      );
      expect(res.status).toBe(403);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
    } finally {
      fetchMock.mockRestore();
    }
  });
});

// ============================================================ brand & static

describe('brand pages', () => {
  it('renders a brand page with Brand JSON-LD', async () => {
    const res = await SELF.fetch('http://localhost/brand/kaanchi');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('"@type":"Brand"');
    expect(html).toContain('Kaanchi');
    expect(html).toContain('Trust 82/100');
  });

  it('404s an unknown brand', async () => {
    expect((await SELF.fetch('http://localhost/brand/nope')).status).toBe(404);
  });

  it('only shows that brand’s products', async () => {
    const other = await seedBrand({ name: 'Other Label', slug: 'other-label' });
    await seedProduct(other, { title: 'Other Label Cotton Kurta' });
    const html = await (await SELF.fetch('http://localhost/brand/kaanchi')).text();
    expect(html).not.toContain('Other Label Cotton Kurta');
  });
});

describe('static pages', () => {
  it('serves the legal and marketing pages', async () => {
    for (const path of ['/about', '/privacy', '/terms', '/for-brands', '/brands', '/collections', '/drops', '/stylist']) {
      const res = await SELF.fetch(`http://localhost${path}`);
      expect(res.status, `${path} should be 200`).toBe(200);
    }
  });

  it('discloses the commercial model on the privacy page', async () => {
    const html = await (await SELF.fetch('http://localhost/privacy')).text();
    expect(html).toMatch(/Anonymous by default/i);
  });
});

describe('404 handling', () => {
  it('renders a designed 404 for pages', async () => {
    const res = await SELF.fetch('http://localhost/definitely-not-a-page');
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("That's not here");
  });

  it('returns JSON for unknown API routes', async () => {
    const res = await SELF.fetch('http://localhost/api/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});

// ============================================================ stylist

describe('POST /api/stylist', () => {
  it('rejects a malformed conversation', async () => {
    const res = await SELF.fetch('http://localhost/api/stylist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('streams SSE and degrades gracefully with no AI provider', async () => {
    const res = await SELF.fetch('http://localhost/api/stylist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'what should I wear to a mehendi?' }] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    // With every provider absent the composite emits its fallback line, and the
    // stream still terminates cleanly rather than hanging.
    expect(text).toContain('event: done');
  });
});

// ============================================================ suggest

describe('GET /api/suggest', () => {
  it('returns brand matches for a prefix', async () => {
    const res = await SELF.fetch('http://localhost/api/suggest?q=kaa');
    expect(res.status).toBe(200);
    const body = await res.json<{ brands: { slug: string }[] }>();
    expect(body.brands.some((b) => b.slug === 'kaanchi')).toBe(true);
  });

  it('handles an empty query without erroring', async () => {
    expect((await SELF.fetch('http://localhost/api/suggest?q=')).status).toBe(200);
  });
});
