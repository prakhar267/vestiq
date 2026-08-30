# Vestiq — Deployment

## Current deployment

| | |
| --- | --- |
| **Live URL** | https://vestiq.prakhargupta267.workers.dev |
| Worker | `vestiq` |
| Cloudflare account | `41ed7bc118fad2779267d4e61988f423` |
| D1 database | `learnfrench-staging-db` (shared, `vestiq_`-prefixed tables — ADR-9) |
| KV namespaces | `CACHE`, `VECTORS`, `SESSIONS` |
| AI | Workers AI (`@cf/meta/llama-3.1-8b-instruct-fast`, `@cf/baai/bge-small-en-v1.5`) |
| Catalogue | Real merchant feeds only; no bundled sample inventory |
| Vector index | v1, 384-dim int8; rebuilt after approved feed syncs |
| Scheduler | GitHub Actions every 15 min, plus manual `POST /admin/jobs/tick` |

Verify at any time:
```bash
curl -s https://vestiq.prakhargupta267.workers.dev/health | jq
npm run check:launch   # strict readiness: inventory + email + scheduler + domain + AI
```

`/health` measures hard runtime dependencies and returns 503 for catalogue
contamination. `/ready` is deliberately stricter and remains 503 until the
deployment has real inventory, email, a non-piggyback scheduler, a custom domain,
and Gemini. Page uptime monitors should target `/health`; launch reviews and
configuration monitors should track `/ready`.

---

## First-time setup on a fresh account

```bash
npm ci
npx wrangler login

# 1. Create bindings
npx wrangler d1 create vestiq-db
npx wrangler kv namespace create CACHE
npx wrangler kv namespace create VECTORS
npx wrangler kv namespace create SESSIONS
# → copy the ids into wrangler.toml

# 2. Secrets
npx wrangler secret put ADMIN_TOKEN      # required; 24+ random chars
npx wrangler secret put GEMINI_API_KEY   # optional; better parsing + vision
npx wrangler secret put RESEND_API_KEY   # optional; outbound alert email

# 3. Schema and deploy
node scripts/migrate.mjs --remote
npm run deploy

# 4. Build the semantic index (needs the AI binding, so it runs in the Worker)
ADMIN_TOKEN=... SITE_URL=https://<your-worker-url> npm run embed
```

`npm run deploy` builds the client bundle and then deploys. `npm run verify`
(typecheck + tests + performance budget) is what CI gates on.

---

## Secrets

| Secret | Required | Effect if missing |
| --- | --- | --- |
| `ADMIN_TOKEN` | **Yes** | `/admin` refuses to authenticate at all; the scheduler cannot run |
| `GEMINI_API_KEY` | No | Falls back to Workers AI. Real image search needs this — the Workers AI path only captions the image |
| `RESEND_API_KEY` | No | Alerts still fire and appear in `/wardrobe`, but no email is sent |

### Adding the Gemini key

Get a key at https://aistudio.google.com/app/api-keys, then:
```bash
npx wrangler secret put GEMINI_API_KEY
```

This upgrades parse quality and enables true multimodal image search. **It also
changes the embedding space** (Gemini vectors are index version 2, Workers AI is
version 1), and vectors are not portable between providers. The system handles the
switch safely without any manual step:

1. queries keep using the v1 index while it is the active one;
2. the embed job progressively re-embeds products at v2;
3. only at ≥90% v2 coverage does `vec:active` flip to v2.

To make that happen promptly rather than over several scheduler ticks:
```bash
ADMIN_TOKEN=... SITE_URL=... npm run embed
```

---

## Background work

There are three interchangeable drivers for scheduled work. All three call the
same `runScheduledTasks()` dispatcher, and each task keeps its own interval marker
in KV — so drivers can be swapped, run together, or fired manually without
duplicating work or losing any.

| Driver | Status here | Notes |
| --- | --- | --- |
| **Traffic-driven** (`SCHEDULER_PIGGYBACK = "1"`) | ❌ disabled | Available as an emergency fallback, but ordinary requests do not own production scheduling. |
| **Manual** (`POST /admin/jobs/tick`) | ✅ available | Token-gated. Use it to force a run during an incident, or after onboarding a brand, without waiting for traffic. |
| **Cloudflare cron trigger** | ❌ unavailable | Preferred, but all 5 free-plan cron slots on this account are used by other Workers. `[triggers]` is commented out in `wrangler.toml`. |
| **GitHub Actions** | ✅ active | The public repository runs `.github/workflows/scheduler.yml` every 15 minutes at no Actions-minute charge. It also verifies `/health`. |

Free a Cloudflare cron slot (or upgrade to Workers Paid) to get a real trigger;
then uncomment `[triggers]` in `wrangler.toml` and set `SCHEDULER_PIGGYBACK = "0"`.

`POST /admin/jobs/tick` runs `runScheduledTasks()` — **the identical code path** the
cron handler uses.

To switch to a native Cloudflare cron: free a trigger slot (or upgrade to Workers
Paid), uncomment `[triggers]` in `wrangler.toml`, set `SCHEDULER_PIGGYBACK = "0"`,
and `npm run deploy`. The cron handler calls the same dispatcher, so nothing else
changes.

The scheduler needs `ADMIN_TOKEN`. CI additionally needs
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (see CI/CD below).

---

## CI/CD

`.github/workflows/ci.yml`:

- **every push/PR** → typecheck (worker + client), 199 Vitest tests, 7
  Playwright/Axe journeys, client build, performance budget;
- **push to `main`** → migrations, deploy, then a **smoke test** that fails the
  deploy unless `/health` reports healthy and `/`, `/search` and `/robots.txt`
  serve real content.

Repo secrets for deploys: `CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit, D1:Edit,
Workers KV:Edit), `CLOUDFLARE_ACCOUNT_ID`.

---

## Custom domain

Cloudflare does not give away domains; `*.workers.dev` is the free option. Once
you own one (`vestiq.in` recommended):

1. Add the zone to Cloudflare and point the registrar at Cloudflare's nameservers.
2. Add a route to `wrangler.toml`:
   ```toml
   routes = [
     { pattern = "vestiq.in", custom_domain = true },
     { pattern = "www.vestiq.in", custom_domain = true }
   ]
   ```
3. **Update `SITE_URL` in `[vars]`** — canonical URLs, sitemaps, JSON-LD and OG
   tags all derive from it. Leaving it stale would point every canonical tag at
   workers.dev and split ranking signals across two hostnames.
4. `npm run deploy`, then update `SITE_URL` in GitHub repo variables.
5. Resubmit the sitemap in Google Search Console.

A custom domain also enables Cloudflare image resizing, which makes the `/img`
proxy actually resize rather than pass through.

---

## Going live with real inventory

The application intentionally starts without invented products. For real traffic:

1. **Apply all migrations.** `0002_free_launch_cleanup.sql` removes the original
   marked sample inventory and paid settings. `0003_launch_integrity_and_retention.sql`
   removes the later reserved-domain catalogue, recalculates counts, and creates
   the account/follow/look tables. Runtime signup, feed, approval and health
   guards prevent reserved destinations from returning.
2. **Onboard real brands** at `/merchant/signup` — they paste a store URL; Shopify
   feeds are auto-derived. Approve them at `/admin/brands`.
3. **Run `npm run embed`** so new products enter the semantic index.
4. **Configure `/health` monitoring** and the alerts in
   `05-sre-readiness.md` §3.

Vestiq is free for shoppers and brands during launch. Product prices link to the
brand's own store; Vestiq does not run checkout, subscriptions, promoted results,
affiliate wrapping, campaign budgets, or payouts.

Note that `/merchant/signup` guesses `https://<domain>/products.json`, which is
correct for the large majority of Indian D2C stores because they run Shopify. The
merchant can correct it at `/merchant/feed`, and every rejected row is shown to
them with a reason — that feedback loop is what makes self-serve onboarding work
without a support queue.

---

## Rollback

```bash
npx wrangler deployments list
npx wrangler rollback --message "reason"
```

Safe by design: migrations are additive only, so an older Worker version runs
unchanged against a newer schema. Preserve that property — never write a migration
that drops or renames a column still in use.

For an urgent behaviour change without a deploy, use the kill switches at
`/admin/flags` (effective within 60 s).
