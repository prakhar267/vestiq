#!/usr/bin/env node
/**
 * Performance budget gate (docs/02-design.md §8).
 *
 * Runs in CI. A discovery product's first paint *is* the pitch, so these limits
 * are treated as build failures rather than aspirations.
 */

import { readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const BUDGETS = [
  { file: 'public/app.js', limitKb: 24, measure: 'gzip', label: 'client JS' },
  { file: 'public/styles.css', limitKb: 14, measure: 'gzip', label: 'critical CSS' },
];

let failed = false;

for (const budget of BUDGETS) {
  if (!existsSync(budget.file)) {
    console.error(`✗ ${budget.label}: ${budget.file} missing — run npm run build:client`);
    failed = true;
    continue;
  }
  const raw = readFileSync(budget.file);
  const bytes = budget.measure === 'gzip' ? gzipSync(raw).length : raw.length;
  const kb = bytes / 1024;
  const ok = kb <= budget.limitKb;
  if (!ok) failed = true;
  console.log(
    `${ok ? '✓' : '✗'} ${budget.label}: ${kb.toFixed(1)} KB ${budget.measure} (limit ${budget.limitKb} KB)`,
  );
}

if (failed) {
  console.error('\nPerformance budget exceeded. Reduce payload or justify a budget change in docs/02-design.md.');
  process.exit(1);
}
console.log('\nAll budgets within limits.');
