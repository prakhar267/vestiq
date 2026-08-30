#!/usr/bin/env node
/** Start an isolated, deterministic local Worker for browser journeys. */

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const database = 'learnfrench-staging-db';
const stateDir = resolve('.wrangler/playwright-state');

// This directory is owned solely by this script; replacing it makes each run
// independent of a developer's local D1 state.
rmSync(stateDir, { recursive: true, force: true });
mkdirSync(stateDir, { recursive: true });
process.on('exit', () => rmSync(stateDir, { recursive: true, force: true }));

function d1(file) {
  execFileSync(
    'npx',
    [
      'wrangler',
      'd1',
      'execute',
      database,
      '--local',
      '--persist-to',
      stateDir,
      '--file',
      file,
      '--yes',
    ],
    { stdio: 'inherit' },
  );
}

d1('migrations/0001_init.sql');
d1('migrations/0002_free_launch_cleanup.sql');
d1('migrations/0003_launch_integrity_and_retention.sql');
d1('tests/fixtures/e2e.sql');

const worker = spawn(
  'npx',
  [
    'wrangler',
    'dev',
    '--local',
    '--port',
    '8791',
    '--persist-to',
    stateDir,
    '--log-level',
    'error',
    '--show-interactive-dev-session=false',
  ],
  { stdio: 'inherit' },
);

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    shuttingDown = true;
    if (worker.exitCode === null && worker.signalCode === null) worker.kill(signal);
  });
}

worker.once('error', (error) => {
  console.error(error);
  process.exit(1);
});

worker.once('exit', (code, signal) => {
  if (shuttingDown) process.exit(0);
  process.exit(code ?? (signal ? 1 : 0));
});
