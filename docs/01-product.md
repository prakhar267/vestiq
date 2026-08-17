# Vestiq — Product Analysis, Naming & PRD

> Role: Founder / Head of Product
> Date: 2026-08-18
> Status: approved for build

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
| **Cold-start on taste** | The first query has no personalisation, so results feel generic. | 20-second **taste onboarding** (visual A/B on 8 pairs) → a taste vector that biases rank from query one. |
| **Monetisation is single-track** | Affiliate only, and affiliate on tiny D2C stores is fragile (many have no program). | Three tracks: affiliate CPA, **merchant self-serve promoted placement (CPC)**, and a **brand analytics subscription**. See §6. |
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

P2 is who pays us. P0/P1 are who we serve. Never confuse the two.

---

## 4. Use cases → functional map

Every use case below maps to a shipped surface. `→` names the implementing route.

### 4.1 Search & discovery (the core loop)

| # | Use case | Example input | Implementation |
| --- | --- | --- | --- |
| U1 | **Mood search** | "quiet luxury but for 25°C" | NL parser → attribute + semantic vector → `/search` |
| U2 | **Occasion search** | "beach wedding guest, not white" | occasion lexicon + negation handling → `/search` |
| U3 | **Constraint search** | "kitten heels under ₹4000, size 39" | hard filters (price/size/colour) applied *after* semantic recall → `/search` |
| U4 | **Styling-problem search** | "what goes with wide-leg olive trousers" | intent classified as `styling_problem` → complementary-category expansion → `/search` |
| U5 | **Brand-reference search** | "something like Sabyasachi but ₹5k" | brand → style-vector lookup → nearest-neighbour in price band → `/search` |
| U6 | **Image search** | screenshot upload | vision → structured attributes + vector → `/search?img=` |
| U7 | **Refine without retyping** | chips: cheaper / longer / cotton / no print | query delta applied to prior parse, preserved in URL → `/search` |
| U8 | **Explain the match** | "why is this here?" | per-result `match_reasons[]` rendered as chips |

### 4.2 The stylist (depth)

| # | Use case | Implementation |
| --- | --- | --- |
| U9 | Multi-turn consult ("packing 5 days Goa, ₹10k total") | `/stylist` — streaming chat, tool-calls into our own search |
| U10 | Build a full look around one item | look-builder tool → complementary slots (top/bottom/shoe/bag) |
| U11 | Budget allocation across a look | constrained optimiser over candidate sets |
| U12 | Save consult as a shoppable lookbook | persists to `/looks/:id`, public + shareable |

### 4.3 Retention (the part the reference product is missing)

| # | Use case | Implementation |
| --- | --- | --- |
| U13 | Wishlist / wardrobe | `/wardrobe`, anonymous-first (cookie), survives sign-in merge |
| U14 | **Price-drop alert** | cron diffs price → notify |
| U15 | **Back-in-stock alert** | cron diffs availability → notify |
| U16 | **Saved intent** ("standing order") | saved query re-run nightly; "6 new matches" digest |
| U17 | Taste onboarding | 8 visual pairs → taste vector → rank bias |
| U18 | Daily drops feed | `/drops` — new arrivals from followed + taste-matched brands |

### 4.4 Trust (the moat)

| # | Use case | Implementation |
| --- | --- | --- |
| U19 | Merchant trust score | computed nightly; shown on every card + PDP |
| U20 | Liveness guarantee | `last_verified_at`; stale items demoted, dead items hidden |
| U21 | Transparent commercial disclosure | promoted items labelled; affiliate disclosure in footer + PDP |
| U22 | Report a bad listing | one tap → `vestiq_reports` → auto-demote at threshold |

### 4.5 Supply side (revenue)

| # | Use case | Implementation |
| --- | --- | --- |
| U23 | Brand self-onboard | `/merchant/signup` → feed URL (Shopify JSON / GMC / CSV) |
| U24 | Feed health dashboard | `/merchant` — rows in/out, rejects with reasons |
| U25 | Demand analytics | queries that matched them, queries that *nearly* matched (gap report) |
| U26 | Promoted placement | budget, CPC bid, capped share-of-page |
| U27 | Payout/commission ledger | click → conversion → commission reconciliation |

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

## 6. Monetisation

| Track | Mechanic | Realistic economics |
| --- | --- | --- |
| **T1 Affiliate CPA** | Tracked hop-out; 8–15% commission on Indian D2C | AOV ₹2,200 × 10% = **₹220/order**. At 2% click→order on 50k clicks/mo = 1,000 orders = **₹2.2L/mo** |
| **T2 Promoted placement (CPC)** | Merchant self-serve, ₹4–12/click, hard-capped at 2 of 24 slots, always labelled | 50k clicks/mo × 8% promoted × ₹7 = **₹28k/mo**, ~100% margin |
| **T3 Brand intelligence (SaaS)** | ₹4,999/mo: demand data, gap report ("312 searches you nearly matched"), competitor share-of-voice | 40 brands = **₹2L/mo**, highest margin, stickiest |

T2 and T3 are why the supply-side portal is in v1 and not "later" — they are the only
revenue lines we fully control. Guardrail: **promoted results never exceed 2/24 slots and
are always visually labelled.** Ranking integrity is the entire asset; renting it out
cheaply is how this business dies.

**Cost per 1,000 searches:** ~₹0 infra on Cloudflare free tier at launch; the only variable
cost is inference, held to ~₹0.02/search by aggressive parse-caching (§ADR-6). Contribution
margin is ~99% — this is a distribution business, not an infra business.

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
| Revenue | Tracked GMV / mo | ₹20L by mo 6 |
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
| Affiliate programs absent on small D2C | High | Direct 10% revenue-share agreements + T2/T3 which need no affiliate program at all |
| Inference cost per search | Medium | Parse-cache on normalised query hash; ~70% hit rate at steady state |
| Google penalises programmatic pages | Medium | Only generate a collection page when ≥12 genuinely matching live SKUs exist; `noindex` otherwise |
| Big marketplace ships the same feature | Medium | They cannot: ranking the long tail cannibalises their own ad revenue. Classic incumbent conflict. |
| Legal — image scraping | Medium | Only ingest via merchant-authorised feeds; hotlink with attribution; documented takedown flow |
