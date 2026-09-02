import type { Env } from '../types';
import { esc, escJson } from '../lib/util';

export interface LayoutOptions {
  env: Env;
  title: string;
  description: string;
  /** Canonical path, e.g. "/search?q=cotton". Absolute URL is derived. */
  path: string;
  nonce: string;
  bodyClass?: string;
  /** JSON-LD blocks, emitted as separate script tags. */
  jsonLd?: unknown[];
  ogImage?: string;
  noindex?: boolean;
  /** Rendered into <head>, e.g. prev/next rel links. */
  head?: string;
  /** Docked header search (every page except home). */
  showHeaderSearch?: boolean;
  /** Mobile bottom search dock. */
  showMobileDock?: boolean;
  activeNav?: 'search' | 'stylist' | 'planner' | 'drops' | 'brands' | 'wardrobe';
}

/**
 * Content Security Policy.
 *
 * No 'unsafe-inline' for scripts — all inline JS carries a per-request nonce.
 * Product imagery is hotlinked from merchant CDNs (ADR-4), so img-src must allow
 * https: broadly; everything else is locked to same-origin.
 */
function csp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    'img-src \'self\' https: data: blob:',
    "font-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; ');
}

export function securityHeaders(nonce: string): Record<string, string> {
  return {
    'Content-Security-Policy': csp(nonce),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=()',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'X-Frame-Options': 'DENY',
  };
}

const NAV = [
  { href: '/search', label: 'Search', key: 'search' as const, desktopOnly: false },
  { href: '/stylist', label: 'Stylist', key: 'stylist' as const, desktopOnly: false },
  { href: '/trip-planner', label: 'Plan', key: 'planner' as const, desktopOnly: false },
  { href: '/drops', label: 'New in', key: 'drops' as const, desktopOnly: true },
  { href: '/brands', label: 'Brands', key: 'brands' as const, desktopOnly: true },
  { href: '/wardrobe', label: 'Saved', key: 'wardrobe' as const, desktopOnly: false },
  { href: '/account', label: 'Account', key: undefined, desktopOnly: true },
];

function header(opts: LayoutOptions): string {
  const nav = NAV.map(
    (item) =>
      `<a href="${item.href}"${item.desktopOnly ? ' class="nav-desktop-only"' : ''}${
        opts.activeNav === item.key ? ' aria-current="page"' : ''
      }>${esc(item.label)}</a>`,
  ).join('');

  return `<header class="site-header"${opts.showHeaderSearch ? ' data-docked="1"' : ''}>
  <div class="inner">
    <a class="wordmark" href="/" aria-label="Vestiq home">vestiq</a>
    ${opts.showHeaderSearch ? `<div class="header-search">${searchBarShell('header')}</div>` : ''}
    <nav class="nav" aria-label="Main">${nav}</nav>
  </div>
</header>`;
}

/** Minimal search form. Progressive enhancement: works as a plain GET form with
 *  JS disabled; the island upgrades it with suggestions and the camera button.
 *
 * This must remain a single-line input. A textarea does not submit when Enter is
 * pressed unless the client bundle has already loaded, which made search look
 * dead on slow connections and whenever JavaScript was blocked. */
export function searchBarShell(variant: 'hero' | 'header' | 'dock', value = ''): string {
  const id = `sb-${variant}`;
  const placeholder =
    variant === 'hero'
      ? 'Search the live catalogue by product, style, colour, or brand'
      : 'Describe what you want…';
  return `<div class="searchbar" data-searchbar data-variant="${variant}">
  <form action="/search" method="GET" role="search">
    <label class="sr-only" for="${id}">Search for clothing</label>
    <input id="${id}" name="q" type="search" value="${esc(value)}" placeholder="${esc(placeholder)}"
      autocomplete="off" autocapitalize="none" spellcheck="false"
      role="combobox" aria-expanded="false" aria-autocomplete="list"
      aria-controls="${id}-suggest" enterkeyhint="search">
    <div class="actions">
      <button type="button" class="icon-btn" data-camera hidden
        aria-label="Search by image">${ICONS.camera}</button>
      <button type="submit" class="icon-btn" aria-label="Search">${ICONS.search}</button>
    </div>
  </form>
  <div class="suggestions" id="${id}-suggest" role="listbox" hidden></div>
</div>`;
}

function footer(env: Env): string {
  const year = new Date().getUTCFullYear();
  return `<footer class="site-footer">
  <div class="wrap">
    <div class="footer-cols">
      <div>
        <h3>Discover</h3>
        <ul>
          <li><a href="/search">Search</a></li>
          <li><a href="/stylist">Ask the stylist</a></li>
          <li><a href="/look-builder">Build a look</a></li>
          <li><a href="/trip-planner">Plan a trip</a></li>
          <li><a href="/drops">New in</a></li>
          <li><a href="/brands">All brands</a></li>
          <li><a href="/collections">Collections</a></li>
        </ul>
      </div>
      <div>
        <h3>For brands</h3>
        <ul>
          <li><a href="/merchant">Merchant login</a></li>
          <li><a href="/merchant/signup">List your brand</a></li>
          <li><a href="/for-brands">Why Vestiq</a></li>
        </ul>
      </div>
      <div>
        <h3>Company</h3>
        <ul>
          <li><a href="/about">About</a></li>
          <li><a href="/privacy">Privacy</a></li>
          <li><a href="/terms">Terms</a></li>
          <li><a href="/account">Account</a></li>
          <li><a href="/profile">Fit profile</a></li>
          <li><a href="/sources">Inventory sources</a></li>
        </ul>
      </div>
    </div>
    <p class="disclosure">
      ${esc(env.SITE_NAME)} is free for shoppers and brands during launch. We are a
      discovery service, not a store; purchases happen on each brand's own website.
      Prices and availability are shown as last verified and can change on the brand's site.
    </p>
    <p class="disclosure">&copy; ${year} ${esc(env.SITE_NAME)}. Made in India.</p>
  </div>
</footer>`;
}

export function layout(opts: LayoutOptions, body: string): string {
  const base = opts.env.SITE_URL.replace(/\/$/, '');
  const canonical = base + opts.path;
  const ogImage = opts.ogImage ?? `${base}/og?title=${encodeURIComponent(opts.title)}`;
  const jsonLd = (opts.jsonLd ?? [])
    .map(
      (block) =>
        `<script type="application/ld+json" nonce="${opts.nonce}">${escJson(block)}</script>`,
    )
    .join('');

  const bodyClass = [opts.bodyClass, opts.showMobileDock ? 'has-dock' : '']
    .filter(Boolean)
    .join(' ');

  return `<!DOCTYPE html>
<html lang="en-IN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.description)}">
<link rel="canonical" href="${esc(canonical)}">
${opts.noindex ? '<meta name="robots" content="noindex,follow">' : '<meta name="robots" content="index,follow,max-image-preview:large">'}
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(opts.env.SITE_NAME)}">
<meta property="og:title" content="${esc(opts.title)}">
<meta property="og:description" content="${esc(opts.description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(ogImage)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#fbfaf8" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0f0e0d" media="(prefers-color-scheme: dark)">
<link rel="stylesheet" href="/styles.css">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="search" type="application/opensearchdescription+xml" title="${esc(opts.env.SITE_NAME)}" href="/opensearch.xml">
${opts.head ?? ''}
${jsonLd}
</head>
<body${bodyClass ? ` class="${esc(bodyClass)}"` : ''}>
<a class="skip-link" href="#main">Skip to content</a>
${header(opts)}
<main id="main">${body}</main>
${footer(opts.env)}
${opts.showMobileDock ? `<div class="mobile-dock">${searchBarShell('dock')}</div>` : ''}
<div class="toast" id="toast" role="status" aria-live="polite" hidden></div>
<script src="/app.js" defer nonce="${opts.nonce}"></script>
</body>
</html>`;
}

/** Inline SVG icons. Inlined rather than sprited to avoid a second request on
 *  the critical path; each is under 200 bytes. */
export const ICONS = {
  search:
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  camera:
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1L8 4h8l1.5 2h1A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  heart:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 20s-7-4.6-7-9.4A4.1 4.1 0 0 1 12 7.7 4.1 4.1 0 0 1 19 10.6C19 15.4 12 20 12 20z"/></svg>',
  check:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m5 13 4 4L19 7"/></svg>',
  alert:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 8v5"/><circle cx="12" cy="16.5" r=".8" fill="currentColor"/><path d="M12 3 2 20h20z"/></svg>',
  bell:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M6 9a6 6 0 1 1 12 0c0 4 1.5 5.5 1.5 5.5h-15S6 13 6 9z"/><path d="M10 18a2 2 0 0 0 4 0"/></svg>',
  arrow:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5"/></svg>',
};
