/// <reference types="@cloudflare/vitest-pool-workers/types" />

/** Vite's ?raw suffix, used to load migration SQL into the test worker. */
declare module '*.sql?raw' {
  const content: string;
  export default content;
}
