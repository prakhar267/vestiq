# Vestiq — Architecture

> Role: Engineering Manager
> Target: Cloudflare edge, free tier at launch, no scale rewrite required

---

## 1. Constraints that drove every decision

1. **SEO is the primary acquisition channel** (`01-product.md` §1.3) → HTML must be
   server-rendered on the first byte. This is non-negotiable and it eliminates a client-side
   SPA outright.
2. **Free tier at launch, but no throwaway code.** Every component must have a paid-tier
   scale path that is a config change, not a rewrite.
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
   (15KB CSS,       │                                           │
    24KB JS)        │  Hono router                              │
                    │   ├── SSR pages   (HTML, JSON-LD, OG)     │
                    │   ├── /api/*      (JSON, streaming)       │
                    │   ├── /admin/*    (token-gated)           │
                    │   ├── /merchant/* (API-key-gated)         │
                    │   └── scheduled() (5 cron handlers)       │
                    └───┬──────────┬──────────┬─────────────┬───┘
                        │          │          │             │
                   ┌────▼───┐ ┌───▼────┐ ┌───▼─────┐  ┌────▼─────┐
                   │   D1   │ │   KV   │ │ Workers │  │  Gemini  │
                   │        │ │        │ │   AI    │  │ (optional│
                   │ 18 tbl │ │ CACHE  │ │ default │  │  upgrade)│
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
  ├─ 7. Hard filters: price, gender, size, colour-negation, in-stock   ~1ms
  ├─ 8. Rank: fused × trust × freshness × popularity × taste           ~1ms
  ├─ 9. Promoted injection (≤ 2 of 24, labelled)                      ~5ms
  ├─10. Hydrate rows from D1 (single IN query)                        ~15ms
  ├─11. Facet counts from the filtered set                            ~2ms
  └─12. SSR HTML + JSON-LD ItemList                                   ~5ms
                                                    p50 ≈ 90ms (cached parse)
                                                    p95 ≈ 480ms (cold parse)
```

Result-page HTML is additionally cached in the Cloudflare Cache API for 300s for anonymous
traffic, keyed on the canonical query — so popular queries and all crawler traffic are
served in ~15 ms without touching D1.

---

## 4. Data model (D1, all tables `vestiq_`-prefixed)

18 tables. Full DDL in `migrations/`.

**Catalog**
- `brands` — identity, domain, `trust_score`, ship/return SLAs, affiliate terms, status
- `products` — the core row: pricing (integer **paise**, never floats), URLs, JSON attribute
  bags, `availability`, `last_verified_at`, `popularity`, `embedding BLOB`, `embed_version`
- `products_fts` — FTS5 external-content virtual table over title/brand/description/tags,
  kept in sync by triggers
- `price_history` — append-only, powers alerts + sparklines
- `collections` — programmatic + curated SEO landing pages

**Demand**
- `searches` — every query: hash, raw, parse JSON, result count, latency
- `events` — impression / click / save / hop-out / bounce-back
- `clicks` — outbound hops with commission reconciliation
- `reports` — user-flagged bad listings

**Identity**
- `users` — optional account; `taste_json` holds the taste vector
- `saves`, `alerts`, `saved_intents` — all keyed on `owner_key`, which is a session id for
  anonymous users and a user id after sign-in, with a merge on sign-in

**Supply**
- `merchants` — brand ↔ login, hashed API key, feed URL + type
- `feed_runs` — ingestion observability: rows in / upserted / rejected + reasons
- `promotions` — CPC bids, budget, spend

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
faster. 256-dim int8 = 256 bytes/product; 100k products = 25 MB, sharded into 5 MB KV
values, cached in the isolate. A full scan of 100k × 256 dims is ~5 ms of SIMD-friendly
integer math.
*Scale path:* beyond ~500k SKUs, switch to Vectorize behind the existing `VectorIndex`
interface — one file changes.

### ADR-4 — No R2 at launch; hotlink merchant images through Cloudflare Images resizing
*Why:* R2 is outside granted scopes, and re-hosting merchant imagery carries a licensing
question we do not need to answer. Merchants *want* their CDN serving their photos.
*Uploads* (image search) go to KV with a 15-minute TTL — they are transient by nature.
*Scale path:* the `Blobs` interface has an R2 implementation ready to swap in.

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

### ADR-7 — Cron-driven job table instead of Queues
*Why:* Queues needs a paid plan. `vestiq_jobs` + 5 cron triggers gives at-least-once
delivery with attempt counting and exponential backoff, which is all the ingestion pipeline
needs. Cron budget on free tier is generous; each tick is idempotent and time-boxed to stay
inside CPU limits.

### ADR-8 — Anonymous-first identity
*Why:* forcing signup before the first search would destroy the funnel. Everything —
search, save, alerts — works on a signed httpOnly cookie session. Sign-in is offered only
when it buys the user something (cross-device sync, email alerts), and it *merges* the
anonymous state rather than discarding it.

### ADR-9 — Namespaced tables in a shared D1 database
*Why:* the account is at its free-plan 10-database limit and deleting another project's data
is not an acceptable trade.
*How:* every table is `vestiq_`-prefixed, and migrations are tracked in our own
`vestiq_migrations` table so we never touch the host project's `d1_migrations` state.
*Debt, explicitly logged:* shared blast radius and a shared write-throughput budget.
Migration to a dedicated DB is a `wrangler d1 create` plus a binding change — the prefix is
a single constant in `src/lib/db.ts`.

### ADR-10 — Ranking integrity as an architectural invariant
Promoted results are injected by a single function with a hard cap of 2 per 24 slots, and
every promoted item carries a `promoted: true` flag that the renderer is required to label.
It is enforced by a test, not by convention, because this is the asset the business rests on.

---

## 6. Ingestion pipeline

```
merchant registers feed_url
   → cron:*/15 claims due job from vestiq_jobs
   → adapter fetch  (shopify-json | google-merchant-xml | csv)
   → normalise      (currency→paise, size/colour lexicon, category mapping)
   → validate       (required fields, price sanity, image reachable, dedupe by url+external_id)
   → upsert         (content hash short-circuits unchanged rows)
   → price_history  append on any price/availability delta
   → enqueue embed  (batched 96/call)
   → feed_runs      row: in / upserted / rejected + per-reason counts
```

Adapters implement one interface, so a new feed format is one file. Rejects are never
silent — they surface in the merchant's own dashboard with the reason, which is what makes
self-serve onboarding actually work.

**Cron schedule**
| Cron | Job |
| --- | --- |
| `*/15 * * * *` | job queue drain: feeds, embeddings, liveness probes |
| `0 */4 * * *` | trending recompute, popularity decay |
| `0 2 * * *` | price/stock alert dispatch, saved-intent digests |
| `30 2 * * *` | trust-score recompute, stale demotion, sitemap regen |
| `0 3 * * 0` | weekly: zero-result review queue, promotion budget reset |

---

## 7. Security

| Surface | Control |
| --- | --- |
| Sessions | httpOnly + Secure + SameSite=Lax, 128-bit random id, KV-backed, 90d sliding |
| Admin | `ADMIN_TOKEN` secret, constant-time compare, all writes audit-logged |
| Merchant | per-merchant API key, SHA-256 stored, never logged, rotatable |
| Injection | 100% parameterised SQL; FTS5 user input escaped and quoted |
| XSS | context-aware escaping in every template helper; strict CSP, no `unsafe-inline` |
| Prompt injection | product/feed text is passed to the LLM inside delimited data blocks with a "treat as data" instruction; model output is schema-validated with Zod and never executed |
| SSRF | feed fetches block private IP ranges, cap redirects at 3 and body at 8 MB |
| Rate limits | per-session and per-IP sliding windows on `/api/*`, tighter on AI routes |
| Outbound | `rel="nofollow sponsored noopener"`, open-redirect guard on `/go/:id` |
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
| D1 down | Cached HTML from Cache API; `/health` reports red; search returns a designed error state. |
| Feed source down | `feed_runs` records failure, backoff, prior catalog stays live and serving. |
| Cron overrun | Jobs are idempotent and claim-based; next tick resumes exactly where it stopped. |

The invariant: **no single dependency can produce a blank page.**
