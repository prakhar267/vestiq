import { Hono } from 'hono';
import type { Env } from '../types';
import { T } from '../lib/db';
import { esc } from '../lib/util';
import { assertSafeUrl } from '../ingest/adapters';

/**
 * SEO surfaces, the image proxy, and OG images.
 *
 * SEO is the primary acquisition channel (docs/01-product.md §1.3), so these
 * routes are first-class product surfaces, not boilerplate.
 */

export const seoRoutes = new Hono<{ Bindings: Env }>();

const SITEMAP_PAGE_SIZE = 5000;
const MAX_IMAGE_REDIRECTS = 3;

seoRoutes.get('/robots.txt', (c) => {
  const base = c.env.SITE_URL.replace(/\/$/, '');
  const body = `User-agent: *
Allow: /
# Endpoints with no indexable content or user-specific state.
Disallow: /api/
Disallow: /go/
Disallow: /admin
Disallow: /merchant
Disallow: /wardrobe
Disallow: /img
Disallow: /og
# Faceted URLs multiply infinitely; the canonical query page is what we want indexed.
Disallow: /search?*brand=
Disallow: /search?*color=
Disallow: /search?*size=
Disallow: /search?*page=

Sitemap: ${base}/sitemap.xml
`;
  return c.text(body, 200, { 'cache-control': 'public, max-age=3600' });
});

/** Sitemap index. Partitioned because product counts will exceed the 50k cap. */
seoRoutes.get('/sitemap.xml', async (c) => {
  const base = c.env.SITE_URL.replace(/\/$/, '');
  let productPages = 1;
  try {
    const row = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n
       FROM ${T.products} p
       JOIN ${T.brands} b ON b.id = p.brand_id
       WHERE p.status = 'active' AND b.status = 'active'`,
    ).first<{ n: number }>();
    productPages = Math.max(1, Math.ceil((row?.n ?? 0) / SITEMAP_PAGE_SIZE));
  } catch {
    // Serve a minimal, valid sitemap even if D1 is unreachable.
  }

  const entries = [
    `${base}/sitemap-static.xml`,
    `${base}/sitemap-brands.xml`,
    `${base}/sitemap-collections.xml`,
    ...Array.from({ length: productPages }, (_, i) => `${base}/sitemap-products/${i + 1}.xml`),
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map((loc) => `<sitemap><loc>${esc(loc)}</loc></sitemap>`).join('\n')}
</sitemapindex>`;
  return c.body(xml, 200, {
    'content-type': 'application/xml; charset=utf-8',
    'cache-control': 'public, max-age=3600',
  });
});

function urlset(urls: { loc: string; lastmod?: number; priority?: string }[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (u) =>
      `<url><loc>${esc(u.loc)}</loc>${
        u.lastmod ? `<lastmod>${new Date(u.lastmod).toISOString().slice(0, 10)}</lastmod>` : ''
      }${u.priority ? `<priority>${u.priority}</priority>` : ''}</url>`,
  )
  .join('\n')}
</urlset>`;
}

const xmlResponse = (xml: string) =>
  new Response(xml, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });

seoRoutes.get('/sitemap-static.xml', (c) => {
  const base = c.env.SITE_URL.replace(/\/$/, '');
  const paths = ['/', '/stylist', '/drops', '/brands', '/collections', '/about', '/for-brands', '/privacy', '/terms'];
  return xmlResponse(urlset(paths.map((p) => ({ loc: base + p, priority: p === '/' ? '1.0' : '0.6' }))));
});

seoRoutes.get('/sitemap-brands.xml', async (c) => {
  const base = c.env.SITE_URL.replace(/\/$/, '');
  const res = await c.env.DB.prepare(
    `SELECT slug, updated_at FROM ${T.brands} WHERE status = 'active' ORDER BY trust_score DESC LIMIT 5000`,
  ).all<{ slug: string; updated_at: number }>();
  return xmlResponse(
    urlset(
      (res.results ?? []).map((b) => ({
        loc: `${base}/brand/${b.slug}`,
        lastmod: b.updated_at,
        priority: '0.7',
      })),
    ),
  );
});

seoRoutes.get('/sitemap-collections.xml', async (c) => {
  const base = c.env.SITE_URL.replace(/\/$/, '');
  // Only indexable collections — thin pages are a sitewide quality liability
  // (docs/01-product.md §8), so they are excluded, not just deprioritised.
  const res = await c.env.DB.prepare(
    `SELECT slug, updated_at FROM ${T.collections}
     WHERE status = 'active' AND indexable = 1 ORDER BY item_count DESC LIMIT 5000`,
  ).all<{ slug: string; updated_at: number }>();
  return xmlResponse(
    urlset(
      (res.results ?? []).map((x) => ({
        loc: `${base}/c/${x.slug}`,
        lastmod: x.updated_at,
        priority: '0.8',
      })),
    ),
  );
});

// The page number is its own path segment: router params bind to whole segments,
// so `/sitemap-products-:page.xml` would never match.
seoRoutes.get('/sitemap-products/:page', async (c) => {
  const base = c.env.SITE_URL.replace(/\/$/, '');
  const raw = (c.req.param('page') ?? '').replace(/\.xml$/, '');
  if (!/^\d+$/.test(raw)) return c.notFound();
  const page = Math.max(1, parseInt(raw, 10) || 1);
  const res = await c.env.DB.prepare(
    `SELECT p.id, p.slug, p.updated_at
     FROM ${T.products} p
     JOIN ${T.brands} b ON b.id = p.brand_id
     WHERE p.status = 'active' AND b.status = 'active'
     ORDER BY p.id LIMIT ? OFFSET ?`,
  )
    .bind(SITEMAP_PAGE_SIZE, (page - 1) * SITEMAP_PAGE_SIZE)
    .all<{ id: string; slug: string; updated_at: number }>();
  return xmlResponse(
    urlset(
      (res.results ?? []).map((p) => ({
        loc: `${base}/p/${p.slug}-${p.id}`,
        lastmod: p.updated_at,
        priority: '0.6',
      })),
    ),
  );
});

seoRoutes.get('/opensearch.xml', (c) => {
  const base = c.env.SITE_URL.replace(/\/$/, '');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>${esc(c.env.SITE_NAME)}</ShortName>
  <Description>${esc(c.env.SITE_TAGLINE)}</Description>
  <InputEncoding>UTF-8</InputEncoding>
  <Image width="16" height="16" type="image/svg+xml">${esc(base)}/favicon.svg</Image>
  <Url type="text/html" method="get" template="${esc(base)}/search?q={searchTerms}"/>
</OpenSearchDescription>`;
  return xmlResponse(xml);
});

seoRoutes.get('/manifest.webmanifest', (c) =>
  c.json(
    {
      name: c.env.SITE_NAME,
      short_name: c.env.SITE_NAME,
      description: c.env.SITE_TAGLINE,
      start_url: '/',
      display: 'standalone',
      background_color: '#fbfaf8',
      theme_color: '#fbfaf8',
      icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' }],
    },
    200,
    { 'cache-control': 'public, max-age=86400' },
  ),
);

/**
 * OG image.
 *
 * Rendered as SVG, which Slack/WhatsApp/LinkedIn handle but Twitter and Facebook
 * do not. Accepted deliberately: product and brand pages — the pages people
 * actually share — set og:image to real merchant photography instead, so this
 * only covers home/search/stylist. Upgrade path is satori + resvg-wasm to emit
 * PNG; tracked in docs/05-sre-readiness.md as a known limitation.
 */
seoRoutes.get('/og', (c) => {
  const title = (c.req.query('title') ?? c.env.SITE_NAME).slice(0, 90);
  const lines: string[] = [];
  let current = '';
  for (const word of title.split(/\s+/)) {
    if ((current + ' ' + word).trim().length > 26) {
      lines.push(current.trim());
      current = word;
    } else {
      current += ' ' + word;
    }
  }
  if (current.trim()) lines.push(current.trim());

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#fbfaf8"/>
  <text x="72" y="120" font-family="Georgia,serif" font-size="40" fill="#14120f" letter-spacing="2">vestiq</text>
  ${lines
    .slice(0, 4)
    .map(
      (line, i) =>
        `<text x="72" y="${250 + i * 74}" font-family="Georgia,serif" font-size="64" fill="#14120f">${esc(line)}</text>`,
    )
    .join('')}
  <text x="72" y="562" font-family="system-ui,sans-serif" font-size="26" fill="#5c564e">${esc(c.env.SITE_TAGLINE)}</text>
  <rect x="0" y="616" width="1200" height="14" fill="#2b2a6b"/>
</svg>`;

  return c.body(svg, 200, {
    'content-type': 'image/svg+xml; charset=utf-8',
    'cache-control': 'public, max-age=86400',
  });
});

/**
 * Image proxy for hotlinked merchant photography (ADR-4).
 *
 * Strictly allowlisted against the hosts of brands we have actually onboarded.
 * Without that allowlist this endpoint would be an open proxy — an SSRF vector
 * and a bandwidth-theft liability.
 */
seoRoutes.get('/img', async (c) => {
  const raw = c.req.query('u');
  const width = Math.min(1600, Math.max(64, parseInt(c.req.query('w') ?? '480', 10) || 480));
  if (!raw) return c.text('missing u', 400);

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return c.text('bad url', 400);
  }
  if (target.protocol !== 'https:') return c.text('https only', 400);

  const allowed = await allowedImageHosts(c.env);
  if (!isAllowedImageTarget(target, allowed)) return c.text('host not allowed', 403);

  const cacheKey = new Request(new URL(c.req.url).toString(), { method: 'GET' });
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  let current = target;
  let upstream: Response | undefined;
  for (let hop = 0; hop <= MAX_IMAGE_REDIRECTS; hop++) {
    if (!isAllowedImageTarget(current, allowed)) return c.text('host not allowed', 403);

    upstream = await fetch(current.toString(), {
      headers: { accept: 'image/*', 'user-agent': 'VestiqImageProxy/1.0 (+https://vestiq.in)' },
      // Redirects are handled manually so an allowlisted CDN cannot bounce the
      // proxy to an attacker-controlled or private destination.
      redirect: 'manual',
      // Cloudflare image resizing, applied when the zone has Images enabled and
      // silently ignored otherwise (workers.dev). The cast is needed because
      // `cf.image` is a request-transform option that workers-types models only on
      // inbound requests.
      cf: { image: { width, fit: 'scale-down', quality: 82, format: 'auto' } },
    } as unknown as RequestInit);

    if (upstream.status < 300 || upstream.status >= 400) break;
    if (hop === MAX_IMAGE_REDIRECTS) return c.text('too many redirects', 502);

    const location = upstream.headers.get('location');
    if (!location) return c.text('bad upstream redirect', 502);
    try {
      current = new URL(location, current);
    } catch {
      return c.text('bad upstream redirect', 502);
    }
  }

  if (!upstream?.ok) return c.text('upstream error', 502);
  const type = upstream.headers.get('content-type') ?? '';
  if (!type.startsWith('image/')) return c.text('not an image', 415);

  const res = new Response(upstream.body, {
    headers: {
      'content-type': type,
      'cache-control': 'public, max-age=604800, immutable',
      'x-content-type-options': 'nosniff',
    },
  });
  c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
});

function isAllowedImageTarget(target: URL, allowed: Set<string>): boolean {
  if (target.username || target.password) return false;
  try {
    // Applies the same private-network/IP-literal SSRF guard as feed fetching.
    assertSafeUrl(target.toString());
  } catch {
    return false;
  }

  const host = target.hostname.toLowerCase();
  return allowed.has(host) || [...allowed].some((allowedHost) => host.endsWith('.' + allowedHost));
}

/** Hosts we will proxy images from: every onboarded brand's own domain. */
async function allowedImageHosts(env: Env): Promise<Set<string>> {
  const cacheKey = 'img:allowed-hosts';
  try {
    const cached = await env.CACHE.get(cacheKey, 'json');
    if (cached) return new Set(cached as string[]);
  } catch {
    /* fall through */
  }

  const hosts = new Set<string>([
    // Common storefront CDNs used by Indian D2C brands.
    'cdn.shopify.com',
    'images.unsplash.com',
  ]);
  try {
    const res = await env.DB.prepare(
      `SELECT domain FROM ${T.brands} WHERE domain IS NOT NULL AND status = 'active'`,
    ).all<{ domain: string }>();
    for (const row of res.results ?? []) {
      const d = row.domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
      if (d) hosts.add(d);
    }
  } catch {
    /* allowlist degrades to the CDN defaults */
  }

  const list = [...hosts];
  try {
    await env.CACHE.put(cacheKey, JSON.stringify(list), { expirationTtl: 600 });
  } catch {
    /* non-fatal */
  }
  return hosts;
}

seoRoutes.get('/favicon.svg', (c) =>
  c.body(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
      <rect width="32" height="32" rx="6" fill="#14120f"/>
      <text x="16" y="23" font-family="Georgia,serif" font-size="20" fill="#fbfaf8" text-anchor="middle">v</text>
    </svg>`,
    200,
    { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=604800' },
  ),
);
