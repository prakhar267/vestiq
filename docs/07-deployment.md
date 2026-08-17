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
| Catalogue | 26 brands · 1,262 products · 14 collections (demo seed) |
| Vector index | v1, 384-dim int8, 1,262 vectors, 1 shard, active |
| Scheduler | GitHub Actions → `POST /admin/jobs/tick` |

Verify at any time:
```bash
curl -s https://vestiq.prakhargupta267.workers.dev/health | jq
```

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

# 3. Schema, data, deploy
node scripts/migrate.mjs --remote
npm run seed                             # demo catalogue; skip for real feeds only
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
| **Cloudflare cron trigger** | ❌ unavailable | Preferred, but all 5 free-plan cron slots on this account are used by other Workers. `[triggers]` is commented out in `wrangler.toml`. |
| **GitHub Actions** (`.github/workflows/scheduler.yml`) | ⚠️ configured, blocked | Calls `POST /admin/jobs/tick` every 15 min. Secrets are set, but runs currently fail with *"recent account payments have failed or your spending limit needs to be increased"* — private-repo Actions minutes are billable. Fix billing, or make the repo public, and it starts working with no code change. |
| **Traffic-driven** (`SCHEDULER_PIGGYBACK = "1"`) | ✅ active | A small share of page views carries the work in `waitUntil`, at most once per 15 min via a KV claim, with a 5 s budget. Never delays a response. Its only weakness is that no traffic means no maintenance. |

Once a cron slot or Actions billing is available, set `SCHEDULER_PIGGYBACK = "0"`
and enable the preferred driver.

`POST /admin/jobs/tick` runs `runScheduledTasks()` — **the identical code path** the
cron handler uses.

Required GitHub configuration:
- repo secret **`ADMIN_TOKEN`** — must match the Worker secret;
- repo variable `SITE_URL` (optional; defaults to the workers.dev URL).

To switch back to a native Cloudflare cron: free a trigger slot (or upgrade to
Workers Paid), uncomment `[triggers]` in `wrangler.toml`, `npm run deploy`, then
disable the Scheduler workflow. Nothing else changes.

---

## CI/CD

`.github/workflows/ci.yml`:

- **every push/PR** → typecheck (worker + client), 181 tests, client build,
  performance budget;
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

The seed catalogue exists so the site is inspectable immediately. For real
traffic:

1. **Remove the demo data** (see `06-runbook.md` → *Reset the demo catalogue*, then
   skip `npm run seed`). Demo brands are tagged `demo` in `style_tags`.
2. **Onboard real brands** at `/merchant/signup` — they paste a store URL; Shopify
   feeds are auto-derived. Approve them at `/admin/brands`.
3. **Set affiliate terms** per brand (`affiliate_tmpl`, `affiliate_rate_bp`) so
   `/go/:id` wraps outbound links with tracking.
4. **Run `npm run embed`** so new products enter the semantic index.
5. **Configure `/health` monitoring** and the alerts in
   `05-sre-readiness.md` §3.

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
