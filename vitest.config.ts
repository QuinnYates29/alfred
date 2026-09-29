import { defineConfig } from 'vitest/config';

// The only deviation from vitest defaults: a headless-safe Xvfb for the Electron acceptance
// suites (test/acceptance/p18). See test/globalSetup-xvfb.ts.
export default defineConfig({
  test: {
    globalSetup: './test/globalSetup-xvfb.ts',
  },
});
