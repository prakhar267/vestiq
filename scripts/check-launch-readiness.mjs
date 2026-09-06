#!/usr/bin/env node

const site = (process.env.SITE_URL || 'http://localhost:8787').replace(/\/$/, '');
const demoMode = process.env.ALLOW_WORKERS_DEV === '1';

async function read(path) {
  const response = await fetch(`${site}${path}`, { headers: { accept: 'application/json' } });
  const body = await response.json().catch(() => null);
  return { response, body };
}

try {
  const [{ response: healthResponse, body: health }, { response: readyResponse, body: ready }] =
    await Promise.all([read('/health'), read('/ready')]);

  if (!healthResponse.ok || health?.status !== 'healthy') {
    console.error(`Health failed (${healthResponse.status})`);
    console.error(JSON.stringify(health, null, 2));
    process.exit(1);
  }

  console.log(`Health: healthy`);
  console.log(`Launch readiness: ${ready?.status ?? `HTTP ${readyResponse.status}`}`);
  for (const [name, check] of Object.entries(ready?.checks ?? {})) {
    const deferred = demoMode && name === 'custom_domain' && !check.ok;
    console.log(`${check.ok ? '✓' : deferred ? '○' : '✗'} ${name}: ${check.note ?? ''}${deferred ? ' (deferred for demo)' : ''}`);
  }
  const blockers = Object.entries(ready?.checks ?? {})
    .filter(([name, check]) => !check.ok && !(demoMode && name === 'custom_domain'));
  if (blockers.length || (!demoMode && (!readyResponse.ok || ready?.status !== 'ready'))) process.exit(1);
  if (demoMode) console.log('Demo readiness: ready (custom domain explicitly deferred)');
} catch (error) {
  console.error(`Could not check ${site}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
