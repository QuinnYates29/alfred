// Vitest defaults + an X display for Electron acceptance tests (see test/setup/xvfb.ts).
// NOTE: keep this a native .mjs config — a .ts config makes vite bundle it through
// node_modules/.vite-temp, which is read-only on worktree checkouts.
// Keep everything else at vitest defaults — acceptance suites assume them.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/setup/xvfb.ts'],
  },
});
