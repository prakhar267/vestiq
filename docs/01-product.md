# Vestiq — Product Analysis, Naming & PRD

> Role: Founder / Head of Product
> Date: 2026-08-18
> Status: amended for a free, real-catalogue-only launch on 2026-08-23

---

## 1. Teardown of the reference product (twin.shop)

### 1.1 What it actually is

Twin is an **AI-native fashion discovery layer** sitting on top of a long tail of ~10,000
independent online stores. It is *not* a marketplace: it does not hold inventory, does not
process payments, and does not own the customer relationship at checkout. It owns the
**intent-to-product hop** and monetises the referral.

Observed surface:

| Element | Observation |
| --- | --- |
| Hero promise | "Fashion the internet hid from you" |
| Primary input | A single free-text box, conversational, not a category tree |
| Example prompt | "matching co-ord set for vacation", "kitten heels under ₹4000" |
| Search modalities | mood, occasion, constraint, styling problem, brand reference, image |
| Secondary product | "Genius" — a longer-form chat stylist |
| Daily content | trending searches, new brands, fresh drops, editorial picks |
| Catalog bias | emerging / lesser-known brands, explicitly *not* the big marketplaces |
| Market | India (₹ pricing, Indian D2C brands: Miakee, Botnia, Truewest, Lino Perros, …) |
| Pricing | Free to the shopper; no consumer paywall exposed |

### 1.2 The actual insight (why this works)

Three structural facts about Indian fashion e-commerce collide:

1. **Supply exploded.** Shopify/WooCommerce made it trivial for a designer in Jaipur to
   open a store. There are tens of thousands of them. Each is individually undiscoverable.
2. **Discovery did not.** Myntra/Ajio/Amazon rank by *commercial* signal — ad spend,
   inventory depth, return rate. A 40-SKU label with no ad budget is structurally invisible
   no matter how good it is. Category trees also force the shopper to translate a *feeling*
   ("something for a beach wedding that isn't sweaty") into a *taxonomy* (Women > Dresses >
   Maxi > Cotton), which is a lossy, frustrating translation.
3. **LLMs just removed the translation cost.** For the first time, "describe the vibe" is a
   viable query interface, and multimodal models can index a garment from its photograph.

So the wedge is: **the query language changed, therefore the index should change.** Whoever
re-indexes the long tail for natural-language intent captures demand that the incumbents
cannot serve, and does so at near-zero marginal cost per merchant.

### 1.3 Where the reference product is weak — our opportunity

Honest critique, i.e. what I would attack if I were competing:

| Weakness | Why it matters | What we do instead |
| --- | --- | --- |
| **Trust gap on the hop-out** | Sending a shopper to an unknown 40-SKU store is scary. Is it real? Will it ship? Return policy? | **Merchant trust score** surfaced inline: domain age, policy presence, ship-time, dispute rate. This is a durable moat and a data asset. |
| **Freshness/accuracy of the long tail** | Small stores go out of stock and stale constantly. A dead link kills trust permanently. | Aggressive **liveness re-crawl** on click-hot SKUs + `last_verified_at` shown to user. Never rank an unverified-in-7-days item on page 1. |
| **Zero retention loop** | Pure search = zero reason to return. Google is one tab away. | **Wardrobe + saved intents + price/restock alerts.** The alert is the retention primitive: it converts a search into an owned, recurring touchpoint. |
| **Cold-start on taste** | The first query has no personalisation, so results feel generic. | Explicit `/taste` onboarding and followed brands produce a bounded ±8% tie-breaker without creating a filter bubble. |
| **Commercial ranking erodes trust** | Paid placement makes relevance harder to believe, especially while the catalogue is young. | The launch is free for shoppers and brands, with no affiliate wrapping, subscriptions, campaign budgets, payouts, or promoted results. |
| **No SEO harvest** | An AI search box is client-side and invisible to Google. Yet "co-ord set for goa vacation under 3000" is *exactly* a long-tail search query. | Every query result page is **server-rendered, indexable, JSON-LD marked up**, with programmatic collection pages. This is the cheapest acquisition channel that exists for this product. |

That last one is the single biggest strategic difference in our build and it drives the
entire architecture choice in `03-architecture.md`.

---

## 2. Naming

### 2.1 Criteria

1. Pronounceable on first sight by an Indian *and* global audience.
2. Not a misspelled English word (dated, and hurts trust for a commerce product).
3. Signals *intelligent finding*, not *marketplace* or *warehouse*.
4. Clean of collisions — and specifically **no collision with Fynd**, which is adjacent
   fashion-commerce and would be a conflict.
5. Short enough to be a wordmark and a verb ("just vestiq it").

### 2.2 Shortlist and rejections

| Candidate | Verdict |
| --- | --- |
| Looma / Threadly / Kurate | Rejected — "loom"/"thread" evoke *manufacturing*, not *taste*; `-ly` reads as B2B SaaS; misspellings are dated. |
| Mira / Muse / Aura | Rejected — beautiful but hopelessly contested trademarks in beauty/fashion. |
| Fyndr / Findly | **Hard reject** — Fynd collision. |
| Drape, Swatch, Drip | Rejected — taken or slang with a short half-life. |
| **Vestiq** | **Selected.** |

### 2.3 Decision: **Vestiq**

From Latin *vestis* (garment) + *IQ*.

- Says "intelligent clothing" without ever saying "AI" in the name — which ages well, since
  "AI" in a consumer brand will read like "e-" or "i-" did within three years.
- Six letters, two syllables, `VES-tik`. Unambiguous phonetics in Indian English.
- Ownable: not a dictionary word, so a strong trademark position and cheap SEO.
- Scales past fashion into beauty/home later without renaming.

**Wordmark:** `vestiq` — always lowercase, letterspaced.
**Tagline:** *Describe it. We'll find it.*
**Voice:** a well-read friend with great taste. Never salesy, never "Hey bestie!!".
**Domains:** `vestiq.in` / `vestiq.com` / `vestiq.shop`. Ships on `*.workers.dev` until a
domain is bought; custom-domain steps in `07-deployment.md`.

---

## 3. Users

**P0 — "Priya", 24, Bengaluru, ₹8–12k/mo discretionary spend.**
Instagram is her lookbook. She screenshots outfits and then fails to find them. Owns
Myntra but finds it "all the same stuff". Buys 2–4 items/month. Cares about *not* showing
up in the same dress as someone else.
*Job:* "I have a picture/feeling in my head. Find me *that*, in my budget, that actually ships."

**P1 — "Aditi", 31, Mumbai, high intent, low time.**
Shops for occasions with hard constraints (a Tuesday-evening work dinner, sister's mehendi).
Constraint-first, not browse-first.
*Job:* "I need this specific thing, by this date, and I don't want to open 20 tabs."

**P2 — "Rohan", founder of a 60-SKU label, the *supply* side.**
Spending ₹40k/mo on Meta ads at a CAC that doesn't work. Cannot get on Myntra's front page.
*Job:* "Put my clothes in front of people who are already asking for exactly what I make."

P0/P1 are the shopper audience and P2 supplies the catalogue. Nobody pays Vestiq
during launch; ranking must be earned only through relevance and trust.

---

## 4. Use cases → launch-status map

This section separates the current free-launch surface from the roadmap. A route
or schema primitive is not counted as a shipped shopper feature unless there is
a reachable user journey for it.

Status key: **Shipped** = reachable launch journey; **Partial** = a narrower,
honest version ships; **Deferred** = not advertised as available.

### 4.1 Search & discovery (the core loop)

| # | Use case | Status | Launch implementation |
| --- | --- | --- | --- |
| U1 | **Mood search** | Shipped | NL parse + lexical/structured recall and semantic recall when an active vector index exists → `/search` |
| U2 | **Occasion search** | Shipped | occasion lexicon + negation handling → `/search` |
| U3 | **Constraint search** | Shipped | validated price/size/colour/material/brand filters enforced after recall → `/search` |
| U4 | **Styling-problem search** | Shipped | `styling_problem` intent maps known garment categories to complementary categories → `/search` |
| U5 | **Brand-reference search** | Shipped for indexed references | “Like X” resolves an indexed brand profile from its catalogue and uses that aesthetic for semantic/structured recall; unindexed references still depend on model knowledge |
| U6 | **Image search** | Shipped | upload → vision-derived text query → shareable `/search?q=…` redirect |
| U7 | **Refine without retyping** | Shipped | removable parse chips, facets, sorting and pagination preserve validated URL state |
| U8 | **Explain the match** | Shipped | per-result `match_reasons[]` rendered as chips |

### 4.2 The stylist (depth)

| # | Use case | Status | Launch implementation |
| --- | --- | --- | --- |
| U9 | Multi-turn consult ("packing 5 days Goa, ₹10k total") | Shipped | `/stylist` streams chat and inserts product-search grids |
| U10 | Build a full look around one item | Shipped | `/look-builder?seed=…` derives complementary slots and keeps the selected item as the foundation |
| U11 | Budget allocation across a look | Shipped | Candidate combinations are evaluated against one total budget rather than independent per-item caps |
| U12 | Save consult as a shoppable lookbook | Shipped | Built looks persist as shareable `/looks/:id` pages and appear in the wardrobe |

### 4.3 Retention (the part the reference product is missing)

| # | Use case | Status | Launch implementation |
| --- | --- | --- | --- |
| U13 | Wishlist / wardrobe | Shipped | `/wardrobe` works anonymously; passwordless email sign-in merges saves, alerts, searches, follows and looks across devices |
| U14 | **Price-drop alert** | Shipped | scheduled price comparison; anonymous shoppers provide an email when arming |
| U15 | **Back-in-stock alert** | Shipped | scheduled availability comparison with the same alert delivery path |
| U16 | **Saved intent** ("standing order") | Shipped | Search pages expose “Save this search”; the initial result set is baselined and only genuinely new matches produce a daily email; shoppers can stop it in `/wardrobe` |
| U17 | Taste onboarding | Shipped | `/taste` captures like/avoid weights; ranking influence remains bounded to ±8% |
| U18 | Daily drops feed | Shipped | `/drops` prioritises followed brands and uses bounded taste weights, falling back to newest-first for a cold session |

### 4.4 Trust (the moat)

| # | Use case | Implementation |
| --- | --- | --- |
| U19 | Merchant trust score | computed nightly; shown on every card + PDP |
| U20 | Liveness guarantee | feed/liveness timestamps drive age-based freshness and stale status; shopper reports go to moderation and do not automatically delist a product |
| U21 | Transparent free-service disclosure | no Vestiq fee or paid ranking; checkout remains on the brand's own site |
| U22 | Report a bad listing | one tap → `vestiq_reports` → admin moderation queue |

### 4.5 Supply side

| # | Use case | Implementation |
| --- | --- | --- |
| U23 | Brand self-onboard | `/merchant/signup` → feed URL (Shopify JSON / GMC / CSV) |
| U24 | Feed health dashboard | `/merchant` — rows in/out, rejects with reasons |
| U25 | Demand analytics | queries that matched them, queries that *nearly* matched (gap report) |
| U26 | Free feed controls | update a feed URL or format, queue a sync, pause automatic syncing, or resume it |
| U27 | Free catalogue insights | search demand and feed-quality reporting without a paid plan |

### 4.6 SEO / growth

| # | Use case | Implementation |
| --- | --- | --- |
| U28 | Indexable query pages | SSR result pages, canonical URLs, JSON-LD `ItemList` |
| U29 | Programmatic collections | `/c/:slug` for `{attribute} × {category} × {price band}` |
| U30 | Brand hub pages | `/brand/:slug` with JSON-LD `Brand` + `Organization` |
| U31 | PDP with rich results | JSON-LD `Product` + `Offer` → price/availability in SERP |
| U32 | Auto sitemaps | cron-regenerated, partitioned, `<lastmod>` accurate |

### 4.7 Platform / admin

`/admin` — catalog QA queue, brand approval, ingestion runs, query-failure review
(zero-result queries are the product roadmap), feature flags, kill switches.

---

## 5. Explicit non-goals for v1

Stated so scope stays honest:

- **No own checkout.** We refer out. Owning payments means owning returns, and returns are
  where fashion margin dies. Revisit at scale with escrow.
- **No user-generated social feed.** Moderation cost without a retention payoff at our size.
- **No native app.** Installable PWA covers it; app store is a distribution decision for
  after PMF.
- **No size/fit prediction.** Requires per-brand fit data we do not have. Faking it destroys
  trust worse than omitting it.

---

## 6. Free launch policy

- Shoppers pay Vestiq nothing and see no paywall or Vestiq checkout.
- Brands pay Vestiq nothing for onboarding, feeds, demand insights, or listing.
- Outbound links are direct brand URLs without affiliate wrapping.
- There are no subscriptions, promoted results, CPC budgets, commissions, or payouts.
- Product prices remain visible because purchases happen independently on each brand's site.

Future monetisation is explicitly out of launch scope and requires a new product,
legal, and ranking-integrity review before any implementation is reintroduced.

---

## 7. Success metrics

**North star: Qualified Hop-Outs per Week** — clicks to merchant that do *not* bounce back
within 10s. Chosen because it is the closest leading indicator of merchant revenue and it
punishes clickbait ranking, which a raw-CTR north star would reward.

| Layer | Metric | v1 target |
| --- | --- | --- |
| Acquisition | Organic sessions / wk | 5,000 by wk 12 |
| Activation | % sessions with ≥1 search | > 70% |
| **Quality** | **Zero-result rate** | **< 3%** |
| Quality | Search → click-through | > 35% |
| Quality | 10s-bounce-back rate | < 25% |
| Retention | W4 return rate | > 20% |
| Retention | Alerts armed / active user | > 1.5 |
| Supply | Live SKUs | 100k |
| Supply | Feed freshness p95 | < 24h |
| Supply | Approved active brands | 50 by mo 6 |
| Health | Search p95 latency | < 800ms |
| Health | Dead-link rate on page 1 | < 0.5% |

**Instrumentation:** every search writes a `vestiq_events` row with parse, latency, result
count, and rank-of-click. Zero-result and zero-click queries feed the admin review queue
weekly. That queue *is* the roadmap — it tells us exactly which supply to go sign.

---

## 8. Risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Merchants refuse feeds | High | Zero-effort onboarding: paste a Shopify URL, we auto-derive `products.json`. No dev work required from them. |
| Free launch has no direct revenue | Medium | Treat monetisation as a later product decision; do not compromise ranking or onboarding while validating demand |
| Inference cost per search | Medium | Parse-cache on normalised query hash; ~70% hit rate at steady state |
| Google penalises programmatic pages | Medium | Only generate a collection page when ≥12 genuinely matching live SKUs exist; `noindex` otherwise |
| Big marketplace ships the same feature | Medium | They cannot: ranking the long tail cannibalises their own ad revenue. Classic incumbent conflict. |
| Legal — image scraping | Medium | Only ingest via merchant-authorised feeds; hotlink with attribution; documented takedown flow |
