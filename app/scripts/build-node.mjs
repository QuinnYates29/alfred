// P18 §8 — bundle src/node/client.ts (+ its CLI entry, ws included) into app/node/alfred-node.mjs:
// one file that runs with plain node or with the app's binary under ELECTRON_RUN_AS_NODE=1.
// esbuild comes from the repo's node_modules (it ships with tsx/vite).
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(APP, '..');
const CLIENT = join(REPO, 'src', 'node', 'client.ts');
const OUT = join(APP, 'node', 'alfred-node.mjs');

// client.ts only runs its CLI when argv[1] looks like client.ts / alfred-node.ts; the bundle is named
// alfred-node.mjs, so export cliMain from it and call it from a tiny entry instead.
const GUARD = /^if \(process\.argv\[1\][^\n]*cliMain\(process\.argv\.slice\(2\)\);\s*$/m;
const exposeCli = {
  name: 'expose-cli',
  setup(b) {
    b.onLoad({ filter: /[\\/]src[\\/]node[\\/]client\.ts$/ }, async (args) => {
      const src = await readFile(args.path, 'utf8');
      if (!GUARD.test(src)) throw new Error('build-node: the CLI guard at the end of src/node/client.ts changed; update GUARD');
      return { contents: `${src.replace(GUARD, '')}\nexport { cliMain };\n`, loader: 'ts' };
    });
  },
};

await build({
  stdin: {
    contents: `import { cliMain } from ${JSON.stringify(CLIENT)};\ncliMain(process.argv.slice(2));\n`,
    resolveDir: REPO,
    sourcefile: 'alfred-node-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: OUT,
  plugins: [exposeCli],
  // ws's optional native speedups: required inside try/catch, fine to leave out.
  external: ['bufferutil', 'utf-8-validate'],
  // ws is CommonJS: give the ESM bundle a real `require` for node builtins.
  banner: { js: "import { createRequire as __alfredCreateRequire } from 'node:module';\nconst require = __alfredCreateRequire(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'warning',
});
console.log(`built ${OUT}`);
