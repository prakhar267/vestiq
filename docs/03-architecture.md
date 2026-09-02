# Vestiq — Architecture

> Role: Engineering Manager
> Target: Cloudflare edge, free product launch, no scale rewrite required
> Scope note: shopper accounts, sign-in merge, taste onboarding, budgeted
> look-building, shareable looks, saved-search digests and personalised drops are
> reachable launch features. Payments and paid placement remain out of scope.

---

## 1. Constraints that drove every decision

1. **SEO is the primary acquisition channel** (`01-product.md` §1.3) → HTML must be
   server-rendered on the first byte. This is non-negotiable and it eliminates a client-side
   SPA outright.
2. **Free product at launch, but no throwaway code.** Shoppers and brands see no
   payment path; infrastructure may still move between Cloudflare service tiers as traffic grows.
3. **Available scopes.** The Wrangler OAuth token grants `d1`, `workers_kv`, `ai`, `workers`,
   `email_sending` — but **not `r2` or `vectorize`**. Those are therefore designed out of the
   critical path (see ADR-3, ADR-4).
4. **D1 free plan is at its 10-database cap**, so this project namespaces its tables with a
   `vestiq_` prefix inside an existing database (ADR-9).

---

## 2. Topology

```
                    ┌───────────────────────────────────────────┐
   Browser ───────► │  Cloudflare Worker  (single deployment)   │
   (<5KB CSS,       │                                           │
    <5KB JS gzip)   │  Hono router                              │
                    │   ├── SSR pages   (HTML, JSON-LD, OG)     │
                    │   ├── /api/*      (JSON, streaming)       │
                    │   ├── /admin/*    (token-gated)           │
                    │   ├── /merchant/* (API-key-gated)         │
                    │   └── scheduled() (interval dispatcher)   │
                    └───┬──────────┬──────────┬─────────────┬───┘
                        │          │          │             │
                   ┌────▼───┐ ┌───▼────┐ ┌───▼─────┐  ┌────▼─────┐
                   │   D1   │ │   KV   │ │ Workers │  │  Gemini  │
                   │        │ │        │ │   AI    │  │ (optional│
                   │ 22 tbl │ │ CACHE  │ │ default │  │  upgrade)│
                   │ + FTS5 │ │ VECTORS│ │ embed + │  └──────────┘
                   │        │ │SESSIONS│ │  LLM    │
                   └────────┘ └────────┘ └─────────┘
```

Single Worker, single deploy artifact. No microservices — at this size they would only add
network hops and failure modes.

---

## 3. Request path: a search

```
GET /search?q=cotton+co-ord+set+under+3000
  │
  ├─ 1. Session cookie resolve (KV SESSIONS, or mint anonymous)      ~2ms
  ├─ 2. Rate-limit check (KV, sliding window)                        ~2ms
  ├─ 3. Normalise query → sha256 hash
  ├─ 4. Parse cache lookup (KV CACHE, 7d TTL)                        ~3ms
  │      MISS → AI structured parse (Workers AI / Gemini)          ~250ms
  │             → heuristic parser on failure                         ~1ms
  ├─ 5. Recall, two arms in parallel:
  │      a. Lexical  — D1 FTS5 MATCH + bm25()                        ~15ms
  │      b. Semantic — embed(text) → int8 cosine over KV index       ~20ms
  ├─ 6. RRF fusion (k=60)                                             ~1ms
  ├─ 7. Hard filters: category, brand, price, colour, material, size   ~1ms
  ├─ 8. Rank: fused × trust × freshness × popularity × taste           ~1ms
  ├─ 9. Hydrate rows from D1 (single IN query)                        ~15ms
  ├─10. Facet counts from the filtered set                            ~2ms
  └─11. SSR HTML + JSON-LD ItemList                                   ~5ms
                                                    p50 ≈ 90ms (cached parse)
                                                    p95 ≈ 480ms (cold parse)
```

Only the parsed query is cached for seven days; result HTML is deliberately not
cached because prices and stock change. The image proxy uses the Cloudflare Cache
API independently of search results.

---

## 4. Data model (D1, all tables `vestiq_`-prefixed)

25 tables. Full DDL in `migrations/`.

**Catalog**
- `brands` — identity, domain, `trust_score`, ship/return SLAs, status
- `products` — the core row: pricing (integer **paise**, never floats), URLs, JSON attribute
  bags, `availability`, `last_verified_at`, `popularity`, `embedding BLOB`, `embed_version`
- `products_fts` — FTS5 external-content virtual table over title/brand/description/tags,
  kept in sync by triggers
- `price_history` — append-only, powers alerts + sparklines
- `collections` — programmatic + curated SEO landing pages

**Demand**
- `searches` — every query: hash, raw, parse JSON, result count, latency
- `events` — impression / click / save / hop-out / bounce-back
- `clicks` — ordinary outbound hop and bounce-back analytics
- `reports` — user-flagged bad listings

**Identity and retention**
- `users`, `auth_tokens` — passwordless email identity; only single-use token
  hashes are stored
- `saves`, `alerts`, `saved_intents`, `brand_follows` — keyed on `owner_key`;
  anonymous session state is transactionally merged into `u:<id>` at sign-in
- `looks`, `look_items` — shareable budgeted outfit output; the public id exposes
  products and prompt but never owner identity
- `profiles` — bounded fit and taste preferences, merged into the shopper account
- `trips`, `trip_looks` — shareable multi-day wardrobes composed from saved looks

**Supply**
- `merchants` — brand ↔ login, hashed API key, feed URL + type
- `feed_runs` — ingestion observability: rows in / upserted / rejected + reasons
- `promotions` — retained only for schema compatibility; emptied and unused in free-launch mode

**Platform**
- `migrations` (own tracker, ADR-9), `flags` (kill switches), `jobs` (cron work queue)

Money is **always integer paise**. Timestamps are **always integer epoch-ms UTC**. Both
rules exist because mixing float rupees or ISO strings into SQLite comparisons is the most
common source of silent commerce bugs.

---

## 5. ADRs

### ADR-1 — Hono + server-rendered HTML, no client framework
**Chosen** over Next.js on Workers and a React SPA.
*Why:* SEO needs first-byte HTML; the perf budget (§02 §8) allows 24 KB of JS, which no
hydrating framework fits in. Next-on-Workers additionally adds an adapter layer that is a
recurring source of runtime surprises.
*Cost:* interactivity is hand-written vanilla islands.
*Mitigation:* only five islands exist (search box, filters, infinite scroll, stylist stream,
save button), each < 5 KB and independently testable.

### ADR-2 — Hybrid retrieval: FTS5 + int8 vectors, fused with RRF
*Why:* lexical alone fails on "quiet luxury for 25°C"; vector alone fails on exact brand and
SKU lookups. RRF needs no score normalisation and no tuning, which matters when there is no
relevance-labelled data yet.
*Alternative rejected:* vector-only — it degrades exactly on the high-intent queries that
convert best.

### ADR-3 — Vectors in D1 blobs + a packed KV index, not Vectorize
*Why:* Vectorize is outside the granted OAuth scopes, and at our scale brute force is simply
faster. 384-dim int8 = 384 bytes/product; 100k products is about 38 MB, sharded into 4 MB KV
values with a bounded isolate cache. A full scan of 100k × 384 dimensions remains simple
integer math.
*Scale path:* beyond ~500k SKUs, switch to Vectorize behind the existing `VectorIndex`
interface — one file changes.

### ADR-4 — No R2 at launch; hotlink merchant images through Cloudflare Images resizing
*Why:* R2 is outside granted scopes, and re-hosting merchant imagery carries a licensing
question we do not need to answer. Merchants *want* their CDN serving their photos.
Image-search uploads are processed within the request and are not retained by
Vestiq. A future retention requirement would need a separate storage review.

### ADR-5 — Provider-abstracted AI: Workers AI default, Gemini optional
*Why:* Workers AI is in-scope and works the moment the account is connected, so the product
is never blocked on a third-party key. Gemini 2.x Flash is better at structured parsing and
vision, so it is a drop-in upgrade selected by the presence of `GEMINI_API_KEY`.
*Contract:* `AiProvider { parseQuery, embed, vision, chat }`. Three implementations —
`workers-ai`, `gemini`, `heuristic`. Selection is runtime, per-capability, with automatic
fallback down the chain on error or timeout.
**Consequence: there is no single point of AI failure.** If every provider fails, the
heuristic parser still returns real results — degraded relevance, never an error page.

### ADR-6 — Cache the *parse*, not the results
*Why:* the parse is the expensive, deterministic step (a query means the same thing today
and tomorrow); results must stay fresh as inventory moves. Parse cached 7d on a normalised
hash (~70% hit rate); result HTML cached only 300s.

### ADR-7 — Interval dispatcher + job table instead of Queues
*Why:* `vestiq_jobs` plus an idempotent dispatcher gives attempt counting and
exponential backoff without adding another runtime dependency. The dispatcher can
be triggered by a Cloudflare cron, an authenticated admin call, or the
traffic-driven fallback. Per-task KV markers prevent duplicate scheduled work.
The public GitHub repository uses a scoped `ADMIN_TOKEN` Actions secret to call
the authenticated endpoint every 15 minutes. Public-repository minutes are free;
traffic-driven scheduling remains an emergency fallback.

### ADR-8 — Anonymous-first shopper identity
*Why:* forcing signup before the first search would destroy the funnel. Search and
saves work on a signed httpOnly cookie session. Anonymous alert and saved-search
creation require an email delivery address. Passwordless one-time links create or
resolve a user and merge saves, alerts, searches, follows and looks without losing
the pre-sign-in journey. Merchant API-key login remains a separate surface.

### ADR-9 — Namespaced tables in a shared D1 database
*Why:* the account is at its free-plan 10-database limit and deleting another project's data
is not an acceptable trade.
*How:* every table is `vestiq_`-prefixed, and migrations are tracked in our own
`vestiq_migrations` table so we never touch the host project's `d1_migrations` state.
*Debt, explicitly logged:* shared blast radius and a shared write-throughput budget.
Migration to a dedicated DB is a `wrangler d1 create` plus a binding change — the prefix is
a single constant in `src/lib/db.ts`.

### ADR-10 — Ranking integrity as an architectural invariant
The free launch has no promoted-placement code path. Every result is organic and can
move only because of relevance, trust, freshness, popularity, optional session taste
data, or an explicit shopper sort. `/taste` writes bounded tag weights whose
ranking effect cannot exceed ±8%.
Merchant-approved affiliate query parameters are appended only after ranking at
the outbound hop; they cannot change the destination host and are disclosed on the PDP.
Tests assert that legacy campaign rows cannot enter retrieval or ranking.

---

## 6. Ingestion pipeline

```
merchant registers feed_url
   → cron:*/15 claims due job from vestiq_jobs
   → adapter fetch  (shopify-json | google-merchant-xml | csv | authorised Souled Store catalogue/collection)
   → normalise      (currency→paise, size/colour lexicon, category mapping)
   → validate       (required fields, price sanity, real non-reserved destination, image, dedupe)
   → upsert         (content hash short-circuits unchanged rows)
   → price_history  append on any price/availability delta
   → enqueue embed  (batched 96/call)
   → feed_runs      row: in / upserted / rejected + per-reason counts
```

Adapters implement one interface, so a new feed format is one file. Rejects are never
silent — they surface in the merchant's own dashboard with the reason, which is what makes
self-serve onboarding actually work.

**Dispatcher intervals**

The external or traffic-driven tick may run every 15 minutes. KV markers decide
which task is due: queue drain (15 minutes), popularity (4 hours), feed scheduling
(6 hours), alerts (12 hours), saved-intent count refresh and trust/collection work
(24 hours), and retention cleanup (7 days). Saved-intent creation baselines the
current result ids; daily processing emails only genuinely new matches and keeps
the intent due when delivery fails.

---

## 7. Security

| Surface | Control |
| --- | --- |
| Sessions | httpOnly + Secure + SameSite=Lax, 128-bit random id, KV-backed, 90d sliding |
| Admin | `ADMIN_TOKEN` secret, constant-time compare, all writes audit-logged |
| Merchant | per-merchant API key, SHA-256 stored, never logged, rotatable |
| Shopper account | 20-minute single-use magic link; only SHA-256 token hash stored; anonymous state merged server-side |
| Injection | 100% parameterised SQL; FTS5 user input escaped and quoted |
| XSS | context-aware escaping in every template helper; strict CSP, no `unsafe-inline` |
| Prompt injection | product/feed text is passed to the LLM inside delimited data blocks with a "treat as data" instruction; model output is schema-validated with Zod and never executed |
| SSRF | feed fetches block private IP ranges, cap redirects at 3 and body at 8 MB |
| Rate limits | per-session and per-IP sliding windows on `/api/*`, tighter on AI routes |
| Outbound | `rel="nofollow noopener"`, open-redirect guard on `/go/:id` |
| Headers | HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, frame-ancestors none |

---

## 8. Observability & failure modes

Structured JSON logs with a `request_id` on every line. `/health` returns component-level
status (D1, KV, AI) plus version and commit. Product analytics live in D1, so the admin
dashboards query the same rows the product writes — no second pipeline to drift.

**Designed degradations** — each one is a test case:

| Failure | Behaviour |
| --- | --- |
| Gemini down / no key | Workers AI, then heuristic parser. Results still returned. |
| All AI down | Heuristic parse + FTS5 lexical only. Banner: "smart search briefly degraded". |
| KV vector index missing | Lexical-only recall. No error. |
| D1 down | `/health` reports red; page requests return a designed error state rather than cached catalogue data. |
| Feed source down | `feed_runs` records failure, backoff, prior catalog stays live and serving. |
| Cron overrun | Jobs are idempotent and claim-based; next tick resumes exactly where it stopped. |

The invariant: **no single dependency can produce a blank page.**
