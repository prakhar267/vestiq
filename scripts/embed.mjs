#!/usr/bin/env node
/**
 * Trigger embedding + vector index build.
 *
 * Embeddings need the Workers AI / Gemini binding, which only exists inside the
 * Worker — so this drives the admin job endpoint rather than reimplementing the
 * pipeline locally. Loops until the queue drains, because each batch is capped
 * at 96 items to stay inside the CPU limit.
 */

const baseUrl = (process.env.SITE_URL ?? 'https://vestiq.workers.dev').replace(/\/$/, '');
const token = process.env.ADMIN_TOKEN;

if (!token) {
  console.error('ADMIN_TOKEN is required.\n  ADMIN_TOKEN=… SITE_URL=… npm run embed');
  process.exit(1);
}

const MAX_ROUNDS = 300;
let round = 0;
let lastPending = Infinity;
let stalledRounds = 0;

while (round < MAX_ROUNDS) {
  round++;
  const res = await fetch(`${baseUrl}/admin/jobs/embed`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    console.error(`\n✗ round ${round} failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    process.exit(1);
  }

  const data = await res.json();
  const pending = data.pending ?? 0;
  process.stdout.write(
    `\r round ${round}: ${data.embedded}/${data.total} embedded, ${pending} pending, index ${data.index_active ? 'live' : 'not live'}    `,
  );

  // Progress is measured by coverage, not by jobs run: this endpoint always
  // enqueues one job, so `ran` is never zero and can't be a stop condition.
  if (pending === 0 && data.index_active) break;

  if (pending >= lastPending) {
    stalledRounds++;
    // Once embedding is complete, a couple of extra rounds let the index build
    // and activate. Beyond that, nothing is progressing.
    if (stalledRounds > 3) {
      console.error(
        `\n✗ stalled at ${pending} pending, index ${data.index_active ? 'live' : 'not live'}.` +
          `\n  Check logs: npx wrangler tail`,
      );
      process.exit(1);
    }
  } else {
    stalledRounds = 0;
  }
  lastPending = pending;
}

console.log('\n✓ Embedding pass complete.');

const health = await fetch(`${baseUrl}/health`).then((r) => r.json()).catch(() => null);
if (health) {
  console.log(`  AI: ${health.checks?.ai?.note ?? 'unknown'}`);
  console.log(`  vectors KV: ${health.checks?.kv_vectors?.ok ? 'reachable' : 'unreachable'}`);
}
console.log('\nCheck the index is live by searching for a vibe, e.g.');
console.log(`  ${baseUrl}/search?q=quiet+luxury+for+hot+weather`);
