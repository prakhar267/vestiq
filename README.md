# Vestiq

**Describe it. We'll find it.**

AI-native fashion discovery for the long tail of independent Indian brands.
Describe what you want the way you actually think about it — a mood, an occasion,
a budget, a screenshot — and find it across brands the big marketplaces bury.

**Live:** https://vestiq.prakhargupta267.workers.dev

---

## The idea in one paragraph

Three things collided in Indian fashion e-commerce. Supply exploded (Shopify made
it trivial for a designer in Jaipur to open a store, so there are tens of
thousands of them). Discovery didn't — marketplaces rank by ad spend and inventory
depth, so a brilliant 40-piece label with no ad budget is structurally invisible.
And LLMs just removed the cost of translating a *feeling* ("something for a beach
wedding that isn't sweaty") into a *taxonomy* (Women > Dresses > Maxi > Cotton).
The query language changed, so the index should change. Vestiq re-indexes the long
tail for natural-language intent.

Full reasoning, including an honest critique of the reference product and where
this differs: [`docs/01-product.md`](docs/01-product.md).

---

## What's built

**Search** — hybrid retrieval: FTS5 lexical + 384-dim int8 semantic vectors, fused
with Reciprocal Rank Fusion, then filtered, ranked by trust/freshness/popularity,
and explained. Six query modalities: mood, occasion, constraint, styling problem,
brand reference, image.

**Transparency** — every search shows what the AI *understood* as removable chips,
and every result shows why it matched. An opaque ranker becomes a correctable
filter set.

**Trust** — per-brand trust scores, `last_verified_at` on every listing, liveness
probes on click-hot items, one-tap problem reports that auto-demote at 3 reports.

**Retention** — anonymous-first wardrobe, price-drop and back-in-stock alerts,
standing searches re-run nightly. (The reference product has none of this.)

**Supply side** — self-serve merchant portal: paste a store URL, feed health with
per-row rejection reasons, a demand gap report ("searches in your categories that
someone else won"), CPC promoted placement, payout ledger.

**Stylist** — streaming multi-turn chat that calls our own search and renders live
product grids inline.

**SEO as the primary channel** — everything is server-rendered on the first byte,
with JSON-LD, partitioned sitemaps, and programmatic collection pages that are only
marked indexable at ≥12 genuinely matching items.

---

## Architecture

One Cloudflare Worker. No client framework — **4.1 KB of JS and 4.7 KB of CSS**,
against budgets of 24 KB and 14 KB enforced in CI. On a discovery product the
first paint *is* the pitch, so a hydration bundle would cost more conversions than
any interaction it buys.

```
Browser ─► Worker (Hono) ─┬─► D1      18 tables + FTS5
                          ├─► KV      cache · vectors · sessions
                          ├─► Workers AI   parse · embed · vision · chat
                          └─► Gemini       optional upgrade
```

Notable decisions, with the reasoning in [`docs/03-architecture.md`](docs/03-architecture.md):

- **Server-rendered HTML, no SPA** (ADR-1) — SEO needs first-byte content.
- **Hybrid retrieval with RRF** (ADR-2) — vector-only fails on exactly the
  high-intent queries that convert best; RRF needs no score normalisation and no
  labelled data to tune.
- **Vectors in D1 blobs + a packed KV index, not Vectorize** (ADR-3) — outside the
  granted OAuth scopes, and at this scale a linear int8 scan is faster than a
  network round-trip to an ANN service.
- **Provider-abstracted AI with per-capability fallback** (ADR-5) —
  `gemini → workers-ai → heuristic`. The heuristic parser never fails and costs
  nothing, so **there is no single point of AI failure**: total inference outage
  degrades relevance, never returns an error page.
- **Cache the parse, not the results** (ADR-6) — the parse is stable and
  expensive; inventory is not.
- **Ranking integrity as an invariant** (ADR-10) — promoted results are capped at
  2 per 24 slots and always labelled, enforced by tests rather than convention.

---

## Getting started

```bash
npm ci
npm run verify          # typecheck (worker + client), 181 tests, perf budget
npm run dev             # local dev at http://localhost:8787
```

Local data:
```bash
node scripts/migrate.mjs --local
node scripts/seed.mjs --local
```

Deploy and operate: [`docs/07-deployment.md`](docs/07-deployment.md) ·
[`docs/06-runbook.md`](docs/06-runbook.md)

---

## Documentation

| Doc | Contents |
| --- | --- |
| [01-product.md](docs/01-product.md) | Teardown of the reference product, naming, PRD, 32 mapped use cases, monetisation, metrics, risks |
| [02-design.md](docs/02-design.md) | Design thesis, tokens, type scale, components, screens, a11y, perf budget |
| [03-architecture.md](docs/03-architecture.md) | Topology, request path, data model, 10 ADRs, ingestion, security, failure modes |
| [04-qa-report.md](docs/04-qa-report.md) | Test strategy, **every bug found and fixed**, security testing, known limitations |
| [05-sre-readiness.md](docs/05-sre-readiness.md) | SLOs, verified failure modes, observability, capacity, scale triggers, rollback |
| [06-runbook.md](docs/06-runbook.md) | Incident procedures and routine operations |
| [07-deployment.md](docs/07-deployment.md) | Deploy, secrets, scheduler, custom domain, going live with real inventory |

The QA report is worth reading even if you skip the rest: several bugs in this
build were *silent* — a dead lexical search arm, embeddings stored as TEXT, an AI
parser that failed on every request — and the section explains how each one hid,
which is more useful than the fixes themselves.

---

## Project layout

```
src/
  index.ts          Worker entry: middleware, routing, /health, error states
  types.ts          Shared domain types
  lib/              db · session · ratelimit · log · util (money, escaping)
  ai/               provider chain · gemini · workers-ai · heuristic parser · lexicon
  search/           orchestrator · lexical (FTS5) · vector (int8/KV) · rank · facets
  ingest/           feed adapters (shopify/GMC/CSV) · normalise · upsert
  jobs/             job queue + scheduled task dispatcher
  routes/           pages · api · admin · merchant · seo · go (outbound)
  ui/               layout (CSP, JSON-LD) · components
  client/           the five progressive-enhancement islands
migrations/         additive-only SQL
scripts/            migrate · seed · embed · build-client · check-budget
tests/              unit + integration (real workerd, real D1)
```

---

## Commercial model

Three tracks, because affiliate alone is fragile on small D2C stores:

1. **Affiliate CPA** — tracked hop-outs, 8–15% on Indian D2C.
2. **Promoted placement (CPC)** — merchant self-serve, hard-capped at 2 of 24
   slots, always labelled.
3. **Brand intelligence (SaaS)** — demand data and the gap report.

Guardrail: paid placement never reorders organic results. Ranking integrity is the
entire asset, and renting it out cheaply is how this business would die.

---

## Status

Deployed and functional on Cloudflare's free tier with a 1,262-product demo
catalogue. Before real traffic: remove the demo data, onboard real brands, add a
custom domain, and configure `/health` alerting — see
[`docs/05-sre-readiness.md`](docs/05-sre-readiness.md) §7.
