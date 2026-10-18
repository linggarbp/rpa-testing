import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Vitest runs the headless suites — everything but the two `.e2e` files, which drive a real browser
 * and stay on the run `npm test` does (see README → Tests). No source file changes for this runner:
 * the suites import `test` from 'node:test', and the alias below points that specifier at the shim.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^node:test$/, replacement: fileURLToPath(new URL('./test/support/vitest-node-test.ts', import.meta.url)) },
    ],
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'test/**/*.e2e.test.ts'],
    // node:test has no per-test timeout; keep the suites honest instead of failing a slow subprocess.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
