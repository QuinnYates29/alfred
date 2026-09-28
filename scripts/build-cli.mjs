// P19 — bundle the CLI into ONE portable file (dist/alfred.mjs) that runs with plain node,
// no node_modules. `./main.js` (the `serve` command) stays external: the bundle must not
// contain server code.
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';

const OUT = 'dist/alfred.mjs';

const result = await build({
  entryPoints: ['src/cli.ts'],
  outfile: OUT,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // bundled CJS deps (yaml) call require() — give the ESM output a real require.
  banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
  logLevel: 'info',
  plugins: [
    {
      name: 'keep-serve-external',
      setup(b) {
        b.onResolve({ filter: /(^|\/)main(\.js)?$/ }, (args) => ({ path: args.path, external: true }));
      },
    },
  ],
});

if (result.warnings.length) console.warn(result.warnings);

// esbuild keeps the entry's `#!/usr/bin/env npx tsx` shebang — replace it with a plain-node one.
let js = readFileSync(OUT, 'utf8');
if (js.startsWith('#!')) js = js.slice(js.indexOf('\n') + 1);
writeFileSync(OUT, `#!/usr/bin/env node\n${js}`, { mode: 0o755 });
console.log(`built ${OUT}`);
