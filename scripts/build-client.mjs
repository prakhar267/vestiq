#!/usr/bin/env node
/** Bundle the client islands to public/app.js. Budget enforced by check-budget.mjs. */

import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';

const OUT = 'public/app.js';

const result = await build({
  entryPoints: ['src/client/app.ts'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2022'],
  outfile: OUT,
  legalComments: 'none',
  metafile: true,
});

if (result.errors.length) {
  console.error(result.errors);
  process.exit(1);
}

const raw = readFileSync(OUT);
const gz = gzipSync(raw).length;

// Keep the served file self-describing for anyone poking at it in devtools.
writeFileSync(OUT, `/* Vestiq client islands. Source: src/client/app.ts */\n${raw.toString()}`);

console.log(
  `built ${OUT}: ${(raw.length / 1024).toFixed(1)} KB raw, ${(gz / 1024).toFixed(1)} KB gzipped`,
);
