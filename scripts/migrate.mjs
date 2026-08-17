#!/usr/bin/env node
/**
 * Apply SQL migrations to D1.
 *
 * Uses our own `vestiq_migrations` tracker rather than wrangler's `d1 migrations`
 * command, because this project shares a database with another project (ADR-9)
 * and must not touch the host's `d1_migrations` state.
 *
 * All DDL is `IF NOT EXISTS`, so re-running is safe and convergent.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
  const dir = mkdtempSync(join(tmpdir(), 'vestiq-mig-'));
  const file = join(dir, 'stmt.sql');
  writeFileSync(file, sql);
  return wrangler(['d1', 'execute', DB, flag, '--file', file, '--json', '-y']);
}

const files = readdirSync('migrations')
  .filter((f) => f.endsWith('.sql'))
  .sort();

if (!files.length) {
  console.error('no migrations found');
  process.exit(1);
}

console.log(`Applying ${files.length} migration(s) to ${DB} (${remote ? 'remote' : 'local'})`);

let applied = 0;
for (const file of files) {
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

console.log(`\nDone. ${applied} migration file(s) applied.`);
