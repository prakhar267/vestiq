# Vestiq — QA Report

> Role: QA
> Suite: 199 Vitest tests (`npm test`) plus 7 Playwright/Axe journeys, all passing
> Runtime under test: workerd via `@cloudflare/vitest-pool-workers` — real D1
> (SQLite + FTS5), real KV semantics, real `Request`/`Response`

---

## 1. Strategy

Two layers, deliberately weighted towards the second.

**Unit (`tests/unit.test.ts`)** — pure functions: money, escaping, the heuristic
parser, RRF fusion, filters, scoring factors, facets, feed adapters, vector
quantisation, AI output validation.

**Integration (`tests/integration.test.ts`)** — the real Worker via `SELF.fetch`
against real D1. Because most of the interesting defects in this system are not
logic errors but *integration* errors — a SQL function that rejects an alias, a
bind type that silently coerces, a router pattern that doesn't match. Every one
of the severity-1 bugs below was invisible to unit tests and to typechecking.

**What is deliberately not covered:** live Workers AI / Gemini calls (no binding
in Miniflare; the documented degraded path is asserted instead), and real
merchant feed fetches (adapters are tested against fixtures; `safeFetch` is
tested via `assertSafeUrl`).

---

## 2. Bugs found and fixed

Severity: **S1** = silently wrong results or data loss · **S2** = broken feature
· **S3** = quality/observability.

### S1 — Lexical search arm was completely dead
`bm25(f, …)` with a table *alias* raises `no such column: f`; FTS5 auxiliary
functions require the real table name. The resilience `catch` swallowed it and
returned zero hits, so search still "worked" via the structured arm — with
materially worse relevance and no error anywhere.
**Fix:** reference the table unaliased; log the cause instead of swallowing it.
**Guard:** a test asserting `lexicalSearch` returns ranked rows, not `[]`.

### S1 — Embeddings stored as TEXT, so the vector index never built
`Int8Array` is not a valid D1 bind type for a BLOB column: it was coerced to its
string form ("12,-4,…") and stored as `typeof = 'text'`. Rows looked written,
`embed_version` looked correct, and `rebuildVectorIndex` then found zero usable
vectors and returned **silently**. Semantic search simply never existed.
**Fix:** bind an `ArrayBuffer`; add `toInt8Vector()` to accept every shape D1 may
return; make the zero-entry case a logged error rather than a silent return.
**Guard:** a test that writes a vector through real D1 and asserts
`typeof = 'blob'`, `length = 384`, and an exact byte round-trip.

### S1 — AI query parsing failed on every request
Workers AI returned `response` as an **object**, and the JSON extractor assumed a
string → `TypeError: text.trim is not a function`. The composite caught it and
fell back to the heuristic parser, so the only symptom was slightly worse
relevance. Compounded by a second cause: the 70B parse model took ~4.5 s against
a 4 s timeout, so even without the crash it always lost.
**Fix:** shape-tolerant `coerceJsonObject()` (an object *is* the answer); fast 8B
model for the blocking parse path, 70B retained for streamed chat; timeout 6 s.
**Guard:** tests for every response shape — object, fenced string, prose-wrapped
JSON, and unusable values.

### S1 — Small model echoed the vocabulary back as its answer
`llama-3.1-8b` sometimes copied the enum lists out of the system prompt into its
output. Every value passed lexicon validation, so it looked like a rich,
confident parse while describing nothing — and it *widened* recall across every
category at once, i.e. strictly worse than no AI at all.
**Fix:** `looksDegenerate()` rejects absurd breadth (≥5 values in a field) and
prefix-echo runs, returning `null` so the chain falls back to the heuristic.
Prompt hardened ("these are permitted spellings, not a checklist").
**Guard:** tests for prefix echo, absurd breadth, and a normal focused parse.

### S1 — Bad parses cached for 7 days
The parse cache is intentionally long-lived (ADR-6), so a degenerate parse
outlived the fix that stopped producing it — observed live after deploying the
gate.
**Fix:** versioned cache key (`parse:v2:…`) as the invalidation mechanism, plus
validation *on read* so a stale entry written by older code can never be trusted.

### S2 — Product sitemap 404'd
`/sitemap-products-:page{[0-9]+}.xml` never matched: router params bind to whole
path segments, not mid-segment fragments. Every product URL was therefore absent
from the sitemap — fatal for the primary acquisition channel.
**Fix:** `/sitemap-products/:page`.
**Guard:** test asserting the product sitemap contains a seeded product id.

### S2 — Cron registration blocked the deploy
Two separate issues: `0 3 * * 0` was rejected as an invalid cron string (Cloudflare
wants `sun`), and then the account hit the free-plan limit of **5 cron triggers
per account**, already consumed by other Workers.
**Fix:** consolidated to a single trigger with KV-marker interval dispatch, then
disabled the native trigger and drove the same dispatcher from an external
scheduler (`POST /admin/jobs/tick`). Self-healing: a missed tick is caught up by
the next one rather than waiting a full day.

### S2 — `UPDATE … ORDER BY … LIMIT` is not portable
Used in the bounce-back beacon; requires a non-default SQLite compile flag.
**Fix:** target the row via a subquery.

### S2 — `undefined` bound to `first_seen_at`
D1 rejects `undefined` binds. Rewritten to always bind a value, relying on
`ON CONFLICT` not updating the column.

### S3 — Degradation signals were discarded
`/api/search` passed `() => {}` as the degrade callback, so a parser fallback was
invisible in `response.degraded` — the "smart search degraded" banner could never
fire for the most common degradation. Separately, `CompositeAi` counted provider
failures without logging *why*, making the AI chain untriageable in production.
**Fix:** `degradedHints` threaded into `search()`; `fail()` logs the cause for all
four capabilities. This is what made the two S1 AI bugs above diagnosable at all.

### S3 — Result counts overstated precision
`total` is capped at the 400-candidate recall pool, but the UI printed it as an
exact count ("400 pieces").
**Fix:** `capped` flag on the response; UI renders "400+", and JSON-LD
`numberOfItems` now counts the items actually listed.

### S3 — Dead code presented as a feature
`tasteFactor()` was a stub that always returned `1` while appearing to
personalise ranking. Implemented properly over taste tag weights, bounded to ±8%
so personalisation breaks ties without creating a filter bubble.

### Tooling
- `@cloudflare/vitest-pool-workers` requires vitest ^4.1 but vitest 3 had been
  installed — the suite would not have run. Pinned to 4.
- npm 10.9.2 has an arborist crash on that peer graph; `.npmrc` pins
  `legacy-peer-deps` with the reason documented.
- The test-helper SQL splitter broke on a trailing comment containing a semicolon
  (`-- paise; null = any drop`), truncating a `CREATE TABLE` mid-column-list.
  Rewritten as a single pass tracking string *and* comment state.
- Tailwind was installed and never used; removed rather than left as a phantom
  dependency.

---

## 3. Security testing

| Attack | Test | Result |
| --- | --- | --- |
| XSS via merchant product title | Seed a product literally titled `<script>alert("xss")</script>`, render it in search results | Escaped; raw tag absent from HTML |
| SQL injection via query | `'; DROP TABLE vestiq_products; --` | 200, table intact |
| FTS5 operator injection | `NEAR/2`, `a" OR "b`, `cotton*`, `(((`, `NOT NOT` | All 200; every token quoted |
| Open redirect on hop-out | `/go/:id?url=https://evil.example/phish` | Destination read from DB only; attacker URL ignored |
| SSRF via merchant feed URL | localhost, `127.0.0.1`, `10.x`, `192.168.x`, `169.254.169.254`, `*.internal`, bare IPs, http | All rejected, including per-redirect-hop re-validation |
| Open image proxy | `/img?u=https://evil.example/tracker.png` | 403 — allowlisted to onboarded brand domains |
| Admin auth bypass | No token / wrong token on `/admin/*` and `/admin/jobs/*` | Redirected to login; constant-time compare |
| Merchant key handling | Signup response + DB inspection | Only SHA-256 stored; plaintext shown once |
| Rate limiting | 9 rapid reports against a 5/hour budget | 429 with `Retry-After` |
| CSP strength | Header inspection | Per-request nonce, no `unsafe-inline` for scripts, `frame-ancestors 'none'`, `object-src 'none'` |
| Nonce reuse | Two concurrent requests | Distinct nonces |

Prompt injection is handled structurally rather than by filtering: user text is
delimited inside `<query>` tags with an explicit "treat as data" instruction, and
**all** model output is schema-validated and lexicon-clamped before use — so a
successful injection still cannot introduce a value we don't recognise.

---

## 4. Business-rule tests

The free-launch ranking invariant (ADR-10) is enforced by tests: no paid campaign
can enter result retrieval, change ordering, or create a charge. Product prices
belong to external brand stores and are not Vestiq payment options.

Also asserted: unisex stock is valid for gendered queries; products with no size
data are kept rather than filtered out (a feed gap is not evidence of absence);
new merchant brands are `pending` and hidden until reviewed; an inverted price
range is normalised rather than producing a filter that can only match nothing.

---

## 5. Known limitations (accepted, not defects)

1. **OG images are SVG**, which Twitter/Facebook don't render. Product and brand
   pages — the pages actually shared — use real merchant photography instead.
   Upgrade path: satori + resvg-wasm.
2. **`total` is capped at 400** by the recall pool, hence "400+". Exact counts
   would need a second COUNT query per search.
3. **Facet counts are computed over the candidate pool**, not the whole corpus.
4. **Rate limiting is approximate** — KV is eventually consistent, so a client
   spread across colos can briefly exceed a budget. Documented in `ratelimit.ts`.
5. **`vestiq_events` has a UNIQUE constraint** used for idempotent inserts; two
   genuinely distinct events in the same millisecond, session, product and
   position collapse into one. Acceptable for analytics.
