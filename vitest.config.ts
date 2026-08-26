import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

/**
 * Tests run inside workerd, not Node, so behaviour under test matches
 * production: real D1 (SQLite + FTS5), real KV semantics, real Request/Response.
 *
 * Bindings are declared here rather than read from wrangler.toml because the
 * production config includes an `[ai]` binding and static `[assets]`, neither of
 * which Miniflare can provide locally. Code paths that need AI are covered by
 * asserting the documented degraded behaviour instead (ADR-5).
 *
 * Note: @cloudflare/vitest-pool-workers 0.21 replaced the old
 * `defineWorkersConfig` / `poolOptions.workers` config with this Vite plugin.
 */
export default defineConfig({
  test: {
    // tests/e2e/* are Playwright specs driving a real wrangler dev server; they
    // must not be collected by Vitest, which would try to run them inside
    // workerd where @playwright/test cannot resolve.
    exclude: ['tests/e2e/**', 'node_modules/**'],
  },
  plugins: [
    cloudflareTest({
      main: './src/index.ts',
      singleWorker: true,
      miniflare: {
        compatibilityDate: '2026-08-01',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: ['DB'],
        kvNamespaces: ['CACHE', 'VECTORS', 'SESSIONS'],
        bindings: {
          SITE_NAME: 'Vestiq',
          SITE_TAGLINE: "Describe it. We'll find it.",
          SITE_URL: 'http://localhost:8787',
          CURRENCY: 'INR',
          EMBED_DIM: '384',
          EMBED_VERSION: '1',
          LOG_LEVEL: 'error',
          ADMIN_TOKEN: 'test-admin-token-at-least-16-chars',
        },
      },
    }),
  ],
});
