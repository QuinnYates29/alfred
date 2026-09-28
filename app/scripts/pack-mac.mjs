// P18 §9 — package Alfred.app for macOS arm64 (unsigned) and zip it:
//   app/dist/Alfred-darwin-arm64/Alfred.app  →  app/dist/Alfred-mac-arm64.zip (Alfred.app + install-mac.sh)
// Runs on Linux or macOS. The zip keeps symlinks (the Electron framework needs them).
// U1: also writes app/build.json (bundled; what the running app reports) and app/dist/latest.json
// ({ version, build, sha256, size, builtAt, commit }) which the Spark serves for Settings → Updates.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitCommit, LATEST, makeBuildInfo, makeLatest, writeJson } from './latest.mjs';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(APP, 'dist');
const require = createRequire(join(APP, 'package.json'));
const { packager } = await import('@electron/packager');
const electronVersion = require('electron/package.json').version;

/** icon.icns from icon.png: an icns container holding the PNG as-is (ic09 = 512×512, valid since 10.7). */
function makeIcns(png, out) {
  const data = readFileSync(png);
  const entry = Buffer.alloc(8);
  entry.write('ic09', 0, 'ascii');
  entry.writeUInt32BE(8 + data.length, 4);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(16 + data.length, 4);
  writeFileSync(out, Buffer.concat([head, entry, data]));
}

// 1. The embedded node (single file, deps bundled) and the icon.
execFileSync(process.execPath, [join(APP, 'scripts', 'build-node.mjs')], { stdio: 'inherit' });
const icns = join(APP, 'assets', 'icon.icns');
if (!existsSync(icns)) makeIcns(join(APP, 'assets', 'icon.png'), icns);
// The CLI (P19): the repo's single-file bundle, shipped in the app for "Install command-line tool…".
const ROOT = resolve(APP, '..');
try {
  execFileSync('npm', ['run', '--silent', 'build:cli'], { cwd: ROOT, stdio: 'inherit' });
  mkdirSync(join(APP, 'cli'), { recursive: true });
  copyFileSync(join(ROOT, 'dist', 'alfred.mjs'), join(APP, 'cli', 'alfred.mjs'));
} catch (e) {
  console.warn(`note: could not build the CLI (${e?.message ?? e}); "Install command-line tool…" will say so`);
}

// The build's identity, bundled as build.json (the app compares it with the server's latest.json).
const info = makeBuildInfo({ version: JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8')).version, commit: gitCommit(ROOT) });
writeJson(join(APP, 'build.json'), info);

// 2. Alfred.app. Only what the app needs at runtime (no runtime npm deps: node_modules stays out).
const KEEP = /^\/(package\.json|build\.json|src|assets|node|cli)(\/|$)/;
const [appDir] = await packager({
  dir: APP,
  name: 'Alfred',
  executableName: 'Alfred',
  platform: 'darwin',
  arch: 'arm64',
  electronVersion,
  out: DIST,
  overwrite: true,
  asar: false, // node/alfred-node.mjs is spawned from disk by the Electron binary in node mode
  prune: false,
  ignore: (p) => p !== '' && !KEEP.test(p),
  icon: icns,
  appBundleId: 'net.popotomodem.alfred',
  appCategoryType: 'public.app-category.developer-tools',
  appCopyright: 'Quinn',
  extendInfo: { NSUserNotificationAlertStyle: 'alert' },
});
const bundle = join(appDir, 'Alfred.app');
if (!existsSync(bundle)) throw new Error(`packager did not produce ${bundle}`);

// 3. Zip Alfred.app + install-mac.sh (symlinks preserved), to a temp name first: the server may be serving
//    the previous zip; latest.json is replaced only after the new zip is complete.
mkdirSync(DIST, { recursive: true });
const zip = join(DIST, 'Alfred-mac-arm64.zip');
const tmpZip = join(DIST, 'Alfred-mac-arm64.tmp.zip');
rmSync(tmpZip, { force: true });
copyFileSync(join(APP, 'install-mac.sh'), join(appDir, 'install-mac.sh'));
if (process.platform === 'darwin') {
  execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', appDir, tmpZip], { stdio: 'inherit' });
} else {
  execFileSync('zip', ['-qry', tmpZip, 'Alfred.app', 'install-mac.sh'], { cwd: appDir, stdio: 'inherit' });
}
renameSync(tmpZip, zip);
const latest = makeLatest(info, zip);
writeJson(LATEST(DIST), latest);
console.log(`packed ${zip} (${(statSync(zip).size / 1048576).toFixed(1)} MiB) · ${latest.version} build ${latest.build} · ${latest.commit}`);
