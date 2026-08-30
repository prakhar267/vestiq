# Vestiq — Design System

> Role: Head of Design
> Implemented in: `public/styles.css`, `src/ui/components.ts`, `src/ui/layout.ts`
> Scope note: this document reflects the reachable free-launch surface after the
> retention and look-builder completion pass.

---

## 1. Design thesis

A fashion discovery product has one job on screen: **make the clothes the loudest thing in
the room.** Every pixel of chrome competes with the product photography.

Three consequences, which are the whole system:

1. **The UI is a gallery wall, not a dashboard.** Near-white paper ground, hairline dividers
   instead of borders, no card shadows, no gradients, no filled containers around products.
   Colour comes *only* from the garments.
2. **Editorial, not e-commerce.** A serif display face for headings and prices makes the
   product feel considered rather than liquidated. Discount-red and countdown timers are
   banned — they signal "clearance", which is the opposite of taste.
3. **The search box is the hero and it never leaves.** It is the product. On desktop it
   docks to the header on scroll; on mobile it becomes a bottom-anchored pill within
   thumb reach.

Anti-goals: no carousels (they hide inventory), no hamburger on desktop, no modal
interstitials, no "AI sparkle" iconography, no purple-blue AI gradient.

---

## 2. Colour

Warm-neutral ground. The accent is a deep ink-indigo — confident, unisex, and it does not
tint product photography the way a saturated brand colour does.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | `#FBFAF8` | `#0F0E0D` | page ground (warm off-white, never pure `#fff`) |
| `--surface` | `#FFFFFF` | `#181615` | raised sheets, inputs |
| `--surface-sunken` | `#F4F2EE` | `#121110` | image placeholders, wells |
| `--ink` | `#14120F` | `#F5F2EE` | primary text |
| `--ink-2` | `#5C564E` | `#A9A29A` | secondary text |
| `--ink-3` | `#8C857B` | `#7A736B` | tertiary, captions |
| `--line` | `#E4DFD7` | `#2A2724` | hairlines (1px) |
| `--accent` | `#2B2A6B` | `#A9A7F0` | interactive, focus, links |
| `--accent-ink` | `#FFFFFF` | `#14120F` | text on accent |
| `--good` | `#2F6B4F` | `#7FC49E` | in stock, verified |
| `--warn` | `#8A5A1B` | `#E0B072` | low stock, stale |
| `--bad` | `#8C2F2F` | `#E89393` | out of stock, errors |

Semantic-only usage: components never reference a hex, only a token. Dark mode is a token
swap via `prefers-color-scheme` plus a manual override on `<html data-theme>`.

**Contrast:** every pairing above is verified ≥ 4.5:1 for body text and ≥ 3:1 for large text
and UI boundaries. `--ink-3` on `--bg` is 4.6:1 — the floor, used only for captions.

---

## 3. Typography

The launch uses resilient system stacks and does not download a custom font file.

- **Display / headings / price:** `ui-serif, "Instrument Serif", Georgia, serif`.
  Instrument Serif is used only when already available on the device; Georgia is
  the normal fallback.
- **UI / body:** `system-ui, -apple-system, "Segoe UI", Inter, sans-serif`.

Fluid scale, `clamp()`-based, 1.2 ratio at mobile widening to 1.25 at desktop:

| Token | Size | Face | Use |
| --- | --- | --- | --- |
| `--t-display` | `clamp(2.5rem, 6vw, 4.5rem)` | serif | homepage hero only |
| `--t-h1` | `clamp(1.75rem, 3.5vw, 2.5rem)` | serif | page titles |
| `--t-h2` | `clamp(1.35rem, 2vw, 1.75rem)` | serif | section heads |
| `--t-h3` | `1.125rem` | sans 600 | card titles, subheads |
| `--t-body` | `0.9375rem` | sans 400 | body, 15px — reads denser than 16 and suits grids |
| `--t-sm` | `0.8125rem` | sans 400 | metadata |
| `--t-xs` | `0.6875rem` | sans 500, `0.08em` tracking, uppercase | eyebrows, badges |

Rules: body line-height 1.55, headings 1.15, display tracking `-0.02em`, measure capped at
68ch, tabular numerals for all prices (`font-variant-numeric: tabular-nums`) so grids don't
jitter.

---

## 4. Space, shape, motion

- **Space:** 4px base — `--s1:4 --s2:8 --s3:12 --s4:16 --s5:24 --s6:32 --s7:48 --s8:64 --s9:96`.
- **Radius:** `--r-sm:6 --r-md:10 --r-lg:16 --r-pill:999`. **Product images are square-cornered
  (`0`)** — a hard edge reads as editorial print; rounded corners read as app-store.
- **Elevation:** hairlines and ground-tone shifts only. Exactly one shadow exists,
  `--shadow-pop`, reserved for the docked search suggestion sheet.
- **Motion:** `--ease: cubic-bezier(0.2,0,0.13,1)`, durations 120/180/260ms. Only opacity and
  transform animate. Image reveal is a 180ms fade from `--surface-sunken` — never a skeleton
  shimmer, which draws the eye away from loaded products. All motion respects
  `prefers-reduced-motion`.
- **Grid:** 4 cols mobile → 8 tablet → 12 desktop, gutter `--s4`, max content width 1320px.
  Product grid: 2 cols @ <640px, 3 @ 640–1024, 4 @ >1024, 5 @ >1440.
  **2-up on mobile, never 1-up** — comparison is the core behaviour in fashion browsing.

---

## 5. Component inventory

Each ships in `src/ui/components.ts` as a pure function returning HTML.

**Search**
- `SearchBar` — the hero. Free-text + camera affordance. Autogrows to 2 lines then scrolls.
  Enter submits; Shift+Enter newlines. `role="combobox"`, `aria-expanded`, arrow-key
  navigable suggestions, `aria-live` result count.
- `SuggestionSheet` — recent, trending, and "did you mean" in one sheet. Keyboard-first.
- `ParseChips` — **the trust device.** Renders what the AI *understood*: `co-ord set`
  `vacation` `≤ ₹3,000` `cotton`. Every chip is individually removable, which turns an
  opaque AI into a transparent, correctable filter set. This single component is the
  difference between "magic that's wrong" and "magic I can steer".
- `RefineRail` — contextual next moves: cheaper · longer · more cotton · less print.
- `FilterSheet` — full facets; bottom sheet on mobile, left rail on desktop.

**Product**
- `ProductCard` — image (3:4, `loading=lazy`, `decoding=async`, explicit dimensions),
  brand eyebrow, title (2-line clamp), price + strike, `TrustPill`, `MatchReasons`,
  and a separate save button. The link and button are sibling interactive targets.
- `MatchReasons` — up to 3 chips: "cotton" · "under ₹3,000" · "similar to Botnia".
- `TrustPill` — verified merchant / ships in Nd / stale-listing warning.
- `PriceBlock` — tabular, strike-through MRP, no percentage-off in red.
- `ProductDetail` — gallery, size/colour, `AlertButton`, price history and
  `SimilarStrip`, plus a labelled direct outbound CTA "View on {brand} →".

**Stylist**
- `ChatThread` — streaming assistant messages, inline product grids mid-message,
  `aria-live="polite"`. Aborts cleanly on navigate.
- `LookBuilder` — prompt, optional foundation item and one total budget. Each
  outfit slot searches the live index; a bounded combination optimiser chooses
  the highest-quality set under budget.
- `ShareableLook` — labelled slots, total/budget summary, direct product cards
  and a stable `/looks/:id` share URL.

**Shell / system**
- `Header` (dock-on-scroll), `Footer` (free-launch and external-store disclosure), `BrandHeader`, `EmptyState`
  (never a dead end — always offers 3 relaxed queries), `Toast`, `Pagination` (real
  `<a href>` links, so it works with JS off and Google can crawl it), `SkipLink`.

---

## 6. Key screens

**Home** — 60vh hero: wordmark, `Describe it. We'll find it.`, the search bar, and six
*live* example chips (one per search modality, so the modality range is discovered by
tapping, not explained by copy). Below: Trending searches · Fresh drops · New brands ·
Vestiq picks. No banner carousel. No newsletter popup.

**Search results** — sticky parse-chip bar under the header (always answers "what did it
think I meant?"), result count + sort, 24-item grid, infinite scroll *with* a real
paginated fallback for crawlers and JS-off. Zero results is a designed state, never a
shrug: it explains which constraint was binding and offers one-tap relaxations.

**PDP** — 60/40 split, sticky right column. Trust block sits directly above the outbound
CTA, because that is the exact moment hesitation peaks.

**Stylist** — centred 720px column, suggested openers, streaming tokens, products inline.

**Wardrobe** — saved grid, cancellable alerts, stoppable standing searches,
followed brands and saved looks. It is anonymous-first; passwordless sign-in
merges all browser state into a cross-device owner.

**Drops** — newest approved products with followed-brand priority and bounded
taste reranking. `/taste` exposes Like / Avoid / Neutral controls without
allowing personalisation to override relevance.

**Merchant portal** — the only screen allowed to look like a dashboard: dense tables,
feed health and a free demand gap report.

---

## 7. Accessibility (WCAG 2.2 AA, non-negotiable)

- Every interactive element reachable and operable by keyboard; visible `:focus-visible`
  ring (2px `--accent`, 2px offset) — never `outline: none`.
- Search combobox implements the full ARIA combobox pattern.
- Result updates announced via `aria-live="polite"` with a count.
- Touch targets ≥ 44×44px. Mobile search pill sits above the home-bar inset
  (`env(safe-area-inset-bottom)`).
- All product images carry generated, meaningful alt text (`{brand} {title}, {colour} {category}`)
  — not "product image".
- Colour is never the sole carrier of meaning: stock state pairs an icon with the hue.
- Fully usable with JavaScript disabled: search is a real `<form method="GET">`, pagination
  is real links, filters are real form controls. JS enhances; it is never required.
- `prefers-reduced-motion` disables all transitions.

Automated journey QA runs Playwright at desktop and 390px mobile widths. Axe checks
WCAG 2.0/2.1 A/AA rules and fails on serious or critical violations. This is a
regression guard, not a substitute for manual screen-reader and zoom testing.

---

## 8. Performance budget

Design constraints, enforced in CI (`npm run check:budget`):

| Budget | Limit |
| --- | --- |
| Critical CSS, inlined | ≤ 14 KB |
| JS shipped on the home/search path | ≤ 24 KB gzipped |
| Fonts | No custom font downloads on the launch path |
| LCP (mobile, 4G) | < 1.8 s |
| CLS | < 0.02 |
| INP | < 150 ms |

This is why there is no client-side framework. On a discovery product, the first paint *is*
the pitch — a 200 KB hydration bundle would cost more conversions than any interaction it buys.
