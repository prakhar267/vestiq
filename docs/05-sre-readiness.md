# Vestiq — Production Readiness Review

> Role: SRE
> Verdict: **cleared for launch** on the free tier, with the four scale triggers
> in §6 tracked. Two items in §7 must be actioned by the account owner.

---

## 1. SLOs

| Service level | Objective | Measured by |
| --- | --- | --- |
| Availability (`/`, `/search`, `/p/*`) | 99.9% / 30d | `/health` polling + Cloudflare analytics |
| Search latency p95 | < 800 ms | `vestiq_searches.latency_ms` |
| Search latency p99 | < 2000 ms | same |
| Zero-result rate | < 3% | `/admin` overview |
| Dead-link rate on page 1 | < 0.5% | liveness probes + user reports |
| Feed freshness p95 | < 24 h | `vestiq_merchants.last_sync_at` |

**Error budget:** 43 min/month. Burn policy — >50% consumed mid-month freezes
feature deploys until the cause is fixed.

Measured on the live deployment: `/health` ~120 ms, home ~1.3 s cold / ~200 ms
warm, search 1.1–2.0 s with a cold AI parse and ~90 ms on a cached parse. The
dominant term is the inference call, which is exactly why the parse is cached for
7 days (ADR-6) rather than the results.

---

## 2. Failure modes, verified

Each row is a designed degradation, and each is covered by a test or was observed
during the build.

| Failure | Behaviour | Verified |
| --- | --- | --- |
| Gemini absent or down | Falls to Workers AI | Live (no Gemini key set; `/health` reports `workers-ai only`) |
| Workers AI parse fails | Falls to heuristic parser; results still returned | Live (observed both the object-shape crash and the timeout) |
| Model returns degenerate parse | Rejected by `looksDegenerate`, falls to heuristic | Live + tests |
| All AI down | Heuristic parse + lexical/structured recall; banner shown | Test asserts `/health` reports `heuristic only` and search still returns |
| Vector index missing / not activated | Semantic arm skipped, lexical + structured carry the query | Live (before the index was built) |
| Embedding provider changes | `embed:version-mismatch` → semantic arm skipped rather than comparing incompatible spaces | By construction (ADR-3) |
| Index built but under 90% coverage | Built, **not activated** — never serves a half-built index | By construction |
| KV read failure (cache/session) | Fails open; rate limits allow, sessions re-mint | By construction |
| D1 down | `/health` → 503; search returns a designed error state, not a stack trace | `onError` handler + test |
| Feed source down | `feed_runs` records the failure, backoff 1 h, prior catalog stays live | By construction |
| Scheduler tick killed mid-run | Jobs are claim-based and idempotent; stale locks recovered after 5 min | By construction |
| Malformed FTS query | Logged, lexical arm returns empty, other arms serve | Test |
| Merchant feed is hostile | SSRF guard, 8 MB cap, 3-redirect cap, per-hop revalidation | Tests |

**Invariant:** no single dependency can produce a blank page. The heuristic
parser and the structured SQL arm together guarantee a result set with zero
external dependencies beyond D1.

---

## 3. Observability

- **Structured JSON logs**, one line per request, always carrying `request_id`
  (`cf-ray` when present). Query *text* is deliberately not logged; queries live
  in D1 where they are the product's most valuable dataset.
- **`/health`** returns component-level status for D1, KV cache, KV vectors, the
  AI chain, and admin configuration, and returns **503** when a hard dependency
  is down — so uptime monitoring measures the product, not just "the Worker
  replied".
- **`response.degraded`** names every fallback that occurred on a request; the
  search UI surfaces a "smart search degraded" badge from it.
- **AI failures log their cause** for all four capabilities. This was added after
  a fallback chain hid two severity-1 bugs behind a silent counter — the single
  highest-value observability change in the build.
- **Product analytics are in D1**, so `/admin` queries the same rows the product
  writes. There is no second pipeline that can drift.

### Alerts to configure (see §7)
| Alert | Condition | Action |
| --- | --- | --- |
| Site down | `/health` non-200 twice in 5 min | Page |
| Unhealthy component | `checks.d1.ok = false` | Page |
| AI fully degraded | `checks.ai.note` contains `heuristic only` | Investigate |
| Zero-result spike | > 8% over 1 h | Check ingestion + parser |
| Scheduler stopped | No `scheduler tick complete` in 60 min | Check the GitHub workflow |
| Feed failures | `feed_status = 'failing'` for > 6 h | Contact merchant |

---

## 4. Capacity, on the free tier

| Resource | Free limit | Current | Headroom |
| --- | --- | --- | --- |
| Worker requests | 100k/day | — | ~100k pageviews/day |
| Worker CPU | 10 ms/request | ~20–40 ms wall, low CPU | Fine (CPU ≠ wall time) |
| D1 rows read | 5M/day | ~450 reads/search | **~11k searches/day** ← binding constraint |
| D1 rows written | 100k/day | ~3/search + ingestion | Fine with content-hash short-circuit |
| D1 storage | 5 GB | ~2 MB at 1,262 SKUs | ~100k+ SKUs |
| KV reads | 100k/day | 3–5/request | Watch |
| KV writes | 1k/day | sessions + rate limits | **Tight** — mitigated by the 1-hour session touch interval and 60 s flag cache |
| Workers AI | daily neuron allocation | 1 parse/uncached search | Mitigated by 70% parse-cache hit rate |
| Vector index | 25 MB/KV value | 485 KB (1,262 × 384 B) | ~65k SKUs per shard, auto-sharded beyond |

**The first ceiling is D1 row reads at roughly 11k searches/day.** The mitigation
is already built (Cache API for anonymous result HTML, parse caching); the fix
beyond that is Workers Paid.

---

## 5. Load characteristics

Verified by inspection and live measurement rather than a synthetic load test —
at this scale the meaningful risks are per-request row reads and inference cost,
both of which are bounded by construction:

- recall pool is hard-capped at 400 candidates, so a search's D1 cost is O(1) in
  catalogue size, not O(n);
- hydration is chunked at 100 bound parameters per statement;
- the vector scan is 1,262 × 384 int8 multiply-accumulates ≈ sub-millisecond, and
  the index is cached in-isolate for 5 minutes with a 24 MB retention ceiling;
- scheduled work is time-boxed (25 s dispatcher budget, 20 s job-drain budget) and
  resumes on the next tick rather than running to the CPU limit.

---

## 6. Scale triggers

| Trigger | Action |
| --- | --- |
| > 8k searches/day | Enable Cache API for anonymous search HTML (300 s); upgrade to Workers Paid |
| > 500k SKUs | Replace the KV brute-force index with Vectorize behind the existing interface (ADR-3) |
| > 50 merchants | Move ingestion to Cloudflare Queues (ADR-7) |
| Own checkout | Dedicated D1 database + a payments provider; revisit ADR-9 |

---

## 7. Pre-launch actions for the account owner

Two items I cannot do without account-level changes:

1. **Configure alerting.** Point an external monitor (Better Stack, Pingdom, or a
   Cloudflare Notification) at `/health` with a 5-minute interval and alert on
   non-200 or on `"status":"unhealthy"`.
2. **Decide the scheduler mechanism.** Background work is currently carried by
   ordinary page traffic (`SCHEDULER_PIGGYBACK = "1"`), because both preferred
   drivers are unavailable on this account: all 5 free-plan Cloudflare cron slots
   are used by other Workers, and GitHub Actions runs are blocked by an Actions
   billing failure on the GitHub account. Traffic-driven scheduling is safe and
   idempotent but stops when traffic stops, so pick one:
   - fix GitHub Actions billing (or make the repo public) — the workflow is already
     configured and will start working with no code change; **or**
   - free a Cloudflare cron slot / upgrade to Workers Paid, then re-enable
     `[triggers]` in `wrangler.toml`.

   Then set `SCHEDULER_PIGGYBACK = "0"`. See `docs/07-deployment.md` for the
   comparison table.

Also recommended before real traffic: a custom domain (see
`docs/07-deployment.md`), and adding `GEMINI_API_KEY` to upgrade parse and vision
quality from the Workers AI baseline.

---

## 8. Rollback

Deploys are immutable Worker versions.

```bash
npx wrangler deployments list
npx wrangler rollback --message "reason"
```

Rollback is safe for code. **Database migrations are additive only** — every
statement is `CREATE TABLE/INDEX IF NOT EXISTS`, no destructive DDL — so an older
Worker version runs unchanged against a newer schema. That property is what makes
rollback a one-command operation and must be preserved: never write a migration
that drops or renames a column in use.

Emergency mitigation without a deploy, via `/admin/flags`:
`ai_parse_enabled`, `vector_search_enabled`, `stylist_enabled`,
`promoted_enabled`, `ingestion_enabled`. Flags take effect within 60 seconds.

---

## 9. Data protection

- Money is integer paise everywhere; timestamps are integer epoch-ms UTC. Both
  are enforced by convention and asserted in tests, because mixing float rupees
  or ISO strings into SQLite comparisons is the classic silent commerce bug.
- Product delisting is **soft** (`availability = 'out_of_stock'`), never a delete,
  so a briefly truncated feed cannot wipe a catalogue and saved/alerted products
  keep resolving.
- Retention: events 90 d, searches 180 d, price history 365 d — pruned weekly to
  bound free-tier storage.
- Session cookies are httpOnly/Secure/SameSite=Lax with 128 bits of entropy;
  admin uses SameSite=Strict.
- The shared-database decision (ADR-9) is the main residual risk: this project
  shares write throughput and blast radius with another project. Table names are
  namespaced and migrations use a separate tracker, but a dedicated database is
  the first thing to do on upgrading.
