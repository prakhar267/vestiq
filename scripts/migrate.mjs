#!/usr/bin/env node
/**
 * Apply SQL migrations to D1.
 *
 * Uses our own `vestiq_migrations` tracker rather than wrangler's `d1 migrations`
 * command, because this project shares a database with another project (ADR-9)
 * and must not touch the host's `d1_migrations` state.
 *
 * Applied files are skipped. This matters because launch-cleanup migrations may
 * contain DML that must never be replayed against a populated catalogue.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const remote = process.argv.includes('--remote');
const DB = 'learnfrench-staging-db'; // must match wrangler.toml database_name
const flag = remote ? '--remote' : '--local';

function wrangler(args) {
  return execFileSync('npx', ['wrangler', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID ?? '41ed7bc118fad2779267d4e61988f423' },
  });
}

function execSql(sql) {
  // `--file` uses D1's bulk-import endpoint, which currently rejects
  // account-owned API tokens even when they have D1 Write access. These
  // migrations are small enough for the query endpoint used by `--command`.
  return execCommand(sql);
}

function execCommand(sql) {
  // Bind the SQL with `=` so statements that begin with a `--` comment cannot
  // be reinterpreted by Wrangler's argument parser as additional CLI flags.
  return wrangler(['d1', 'execute', DB, flag, `--command=${sql}`, '--json', '-y']);
}

function parseRows(output) {
  const payload = JSON.parse(output);
  return payload.flatMap((entry) => entry.results ?? []);
}

const files = readdirSync('migrations')
  .filter((f) => f.endsWith('.sql'))
  .sort();

if (!files.length) {
  console.error('no migrations found');
  process.exit(1);
}

console.log(`Applying ${files.length} migration(s) to ${DB} (${remote ? 'remote' : 'local'})`);

// Bootstrap the project-local tracker before looking for applied files. This is
// intentionally separate from 0001 so a fresh database and an existing shared
// database follow the same code path.
execSql(`CREATE TABLE IF NOT EXISTS vestiq_migrations (
  name TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);`);

const appliedRows = parseRows(execCommand('SELECT name FROM vestiq_migrations ORDER BY name;'));
const alreadyApplied = new Set(appliedRows.map((row) => String(row.name)));

let applied = 0;
let skipped = 0;
for (const file of files) {
  if (alreadyApplied.has(file)) {
    console.log(`  - ${file} (already applied)`);
    skipped++;
    continue;
  }

  const sql = readFileSync(join('migrations', file), 'utf8');
  try {
    execSql(sql);
    // Record after success. INSERT OR IGNORE keeps re-runs quiet.
    execSql(
      `INSERT OR IGNORE INTO vestiq_migrations (name, applied_at) VALUES ('${file}', ${Date.now()});`,
    );
    console.log(`  ✓ ${file}`);
    applied++;
  } catch (err) {
    const message = err.stderr?.toString() ?? err.stdout?.toString() ?? String(err);
    console.error(`  ✗ ${file}\n${message.slice(0, 2000)}`);
    process.exit(1);
  }
}

console.log(`\nDone. ${applied} migration file(s) applied, ${skipped} skipped.`);
