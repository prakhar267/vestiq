# Vestiq — Runbook

Operational procedures. Every command assumes the repo root and a
`wrangler login` session (or `CLOUDFLARE_API_TOKEN` set).

```bash
export CLOUDFLARE_ACCOUNT_ID=41ed7bc118fad2779267d4e61988f423
export SITE_URL=https://vestiq.prakhargupta267.workers.dev
export ADMIN_TOKEN=...      # the secret set via `wrangler secret put ADMIN_TOKEN`
```

---

## Quick reference

| Task | Command |
| --- | --- |
| Health | `curl -s $SITE_URL/health \| jq` |
| Live logs | `npx wrangler tail vestiq --format pretty` |
| Deploy | `npm run deploy` |
| Rollback | `npx wrangler rollback` |
| Run all scheduled work now | `curl -X POST -H "authorization: Bearer $ADMIN_TOKEN" $SITE_URL/admin/jobs/tick` |
| Drain the job queue | `… /admin/jobs/drain` |
| Rebuild embeddings + index | `npm run embed` |
| Sync all due feeds | `… /admin/jobs/feeds` |
| Recompute trust scores | `… /admin/jobs/trust` |
| Refresh collections | `… /admin/jobs/collections` |
| Dispatch alerts | `… /admin/jobs/alerts` |
| Query the DB | `npx wrangler d1 execute learnfrench-staging-db --remote --command "..."` |

---

## Incident: site is down

1. `curl -s $SITE_URL/health | jq` — which component is red?
2. `npx wrangler tail vestiq --format pretty` and reproduce.
3. If a recent deploy is implicated: `npx wrangler rollback`. Safe by design —
   migrations are additive only (see `05-sre-readiness.md` §8).
4. If D1 is red: check the Cloudflare status page. Search will serve a designed
   error state; the site will not blank out.

## Incident: search returns nothing / bad results

Work down the arms in order — this is exactly how the launch bugs were found.

1. **Is the lexical arm alive?**
   ```bash
   npx wrangler d1 execute learnfrench-staging-db --remote \
     --command "SELECT COUNT(*) FROM vestiq_products_fts;"
   ```
   Zero rows means ingestion wrote products without FTS rows — re-run the feed
   sync. `npx wrangler tail` will show `lexical search failed` if the MATCH
   expression or `bm25()` call is broken.

2. **Is the semantic arm alive?**
   ```bash
   npx wrangler kv key get --namespace-id cfb89dafd6de444e9e76a0678c4260f5 "vec:v1:meta" --remote --text
   npx wrangler d1 execute learnfrench-staging-db --remote \
     --command "SELECT typeof(embedding) t, length(embedding) len, COUNT(*) n FROM vestiq_products WHERE embedding IS NOT NULL GROUP BY t, len;"
   ```
   Expect `typeof = blob` and `length = 384`. **If `typeof = 'text'`, embeddings
   were written with a bad bind type** — that regression is guarded by a test, but
   if it recurs: `npm run embed` after
   `UPDATE vestiq_products SET embed_version = 0, embedding = NULL;`.
   No `vec:active` key means the index was built but coverage was under 90%.

3. **Is the parser degrading?**
   ```bash
   curl -s "$SITE_URL/api/search?q=cotton+kurta" | jq '{provider: .parse.provider, degraded, total}'
   ```
   `provider: "heuristic"` plus `degraded: ["parse:workers-ai"]` means the model
   call failed — `wrangler tail` will log the cause under `ai provider failed`.
   Search still works; relevance is reduced.

4. **Suspect a poisoned parse cache?** Parses are cached 7 days. Bump
   `PARSE_CACHE_VERSION` in `src/search/index.ts` and deploy — that is the
   invalidation mechanism. To clear one query:
   ```bash
   # hash = sha256 of the normalised query
   npx wrangler kv key delete --namespace-id f66a3a5800ec49f29737a4bf9c3871e2 --remote "parse:v2:<hash>"
   ```

## Incident: scheduled work has stopped

Symptom: no `scheduler tick complete` log for over an hour; feeds stale.

1. Check the **Scheduler** workflow in GitHub Actions. GitHub disables scheduled
   workflows on repos with no activity for 60 days — re-enable it.
2. Verify the `ADMIN_TOKEN` repo secret still matches the Worker secret.
3. Run it by hand: `curl -X POST -H "authorization: Bearer $ADMIN_TOKEN" $SITE_URL/admin/jobs/tick`
4. Inspect the queue and interval markers:
   ```bash
   npx wrangler d1 execute learnfrench-staging-db --remote \
     --command "SELECT type, status, COUNT(*) n, MAX(last_error) err FROM vestiq_jobs GROUP BY type, status;"
   npx wrangler kv key list --namespace-id f66a3a5800ec49f29737a4bf9c3871e2 --remote --prefix "cron:last:"
   ```
   Jobs stuck in `running` are recovered automatically after 5 minutes. To force a
   task to run now, delete its `cron:last:<name>` marker.

## Incident: a merchant's products vanished

Products are soft-delisted, never deleted.

```bash
npx wrangler d1 execute learnfrench-staging-db --remote --command \
  "SELECT status, availability, COUNT(*) FROM vestiq_products WHERE brand_id='<id>' GROUP BY 1,2;"
npx wrangler d1 execute learnfrench-staging-db --remote --command \
  "SELECT started_at, status, rows_in, rows_upserted, rows_rejected, reject_reasons, error
   FROM vestiq_feed_runs WHERE brand_id='<id>' ORDER BY started_at DESC LIMIT 5;"
```

- `rows_in = 0` → the merchant's feed URL is broken or empty.
- High `rows_rejected` → read `reject_reasons`; the merchant sees the same
  breakdown at `/merchant/feed`.
- All `out_of_stock` → the feed stopped listing them (correct behaviour), or the
  merchant genuinely sold out.
- `status = 'stale'` → not verified in 21 days, or auto-demoted by 3+ user
  reports. Check `vestiq_reports`.

## Incident: inference bill / neuron budget spiking

1. `curl -X POST -H "authorization: Bearer $ADMIN_TOKEN" $SITE_URL/admin/flags` —
   or use the UI to turn off `ai_parse_enabled`. Search falls to the heuristic
   parser immediately; the product keeps working.
2. Check the parse-cache hit rate — a low rate means queries are unusually diverse
   or the cache version was just bumped.
3. Tighten `RULES.ai_parse` / `RULES.stylist` in `src/lib/ratelimit.ts`.

## Incident: abusive traffic

1. Identify from `wrangler tail` (`request_id`, path, `bot`).
2. Tighten the relevant budget in `src/lib/ratelimit.ts` and deploy.
3. For sustained abuse, add a Cloudflare WAF rule at the zone level — cheaper than
   Worker invocations.

---

## Routine: onboard a brand manually

```bash
# 1. Create the brand + merchant via the normal flow, then approve it:
npx wrangler d1 execute learnfrench-staging-db --remote --command \
  "UPDATE vestiq_brands SET status='active' WHERE slug='<slug>';"
npx wrangler d1 execute learnfrench-staging-db --remote --command \
  "UPDATE vestiq_merchants SET status='approved', next_sync_at=0 WHERE email='<email>';"

# 2. Sync and index
curl -X POST -H "authorization: Bearer $ADMIN_TOKEN" $SITE_URL/admin/jobs/feeds
npm run embed
```

Review new brands at `/admin/brands`. Approval is a deliberate gate: an unreviewed
catalogue can degrade every shopper's results.

## Routine: rotate the admin token

```bash
npx wrangler secret put ADMIN_TOKEN     # paste the new value
```
Then update the `ADMIN_TOKEN` secret in GitHub repo settings, or the scheduler
workflow will start failing.

## Routine: rotate a merchant API key

```bash
NEW_KEY="vq_$(node -e "console.log([...crypto.getRandomValues(new Uint8Array(32))].map(b=>'0123456789abcdefghijklmnopqrstuvwxyz'[b%36]).join(''))")"
HASH=$(node -e "crypto.subtle.digest('SHA-256',new TextEncoder().encode(process.argv[1])).then(b=>console.log([...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')))" "$NEW_KEY")
npx wrangler d1 execute learnfrench-staging-db --remote --command \
  "UPDATE vestiq_merchants SET api_key_hash='$HASH', api_key_hint='${NEW_KEY: -4}' WHERE email='<email>';"
echo "Send this to the merchant over a secure channel: $NEW_KEY"
```

## Routine: reset the demo catalogue

```bash
npx wrangler d1 execute learnfrench-staging-db --remote --command \
  "DELETE FROM vestiq_products_fts; DELETE FROM vestiq_price_history; DELETE FROM vestiq_products; DELETE FROM vestiq_brands WHERE style_tags LIKE '%demo%';"
npm run seed
npm run embed
```

> **Careful:** this database is shared with another project (ADR-9). Only ever
> touch `vestiq_`-prefixed tables. Never run an unprefixed `DROP` or a bare
> `DELETE FROM` against a table without the prefix.

## Routine: move to a dedicated D1 database

The debt logged in ADR-9. Requires a free database slot or Workers Paid.

```bash
npx wrangler d1 create vestiq-db
# update database_name + database_id in wrangler.toml
# set PREFIX = '' in src/lib/db.ts   (nothing else hardcodes a table name)
node scripts/migrate.mjs --remote
npm run seed && npm run embed
npm run deploy
```
