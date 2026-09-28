'use strict';
// U1 — self-update for the Mac app. The Spark serves GET /api/v1/app/latest ({version, build, sha256, size,
// builtAt, commit}) and GET /api/v1/app/download (the zip), both behind the token. The flow:
//   check → download (configured origin only, Bearer token) → sha256 must equal latest.json (else refuse,
//   nothing is unpacked) → `ditto -x -k` → the new bundle's CFBundleIdentifier must equal ours →
//   a helper script (bash, detached) waits for this PID to exit, swaps the bundle (old one kept as
//   Alfred.app.previous), `xattr -cr` + ad-hoc `codesign`, relaunches with `open`, and puts the old bundle
//   back if any step fails → app.quit().
// Everything here takes its dependencies as arguments so the tests can drive it off-Mac.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile: realExecFile, spawn: realSpawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const BUILD_JSON = path.join(__dirname, '..', 'build.json');
const CHECK_EVERY_MS = 6 * 60 * 60_000;

/** What this app is: build.json written by pack-mac (absent when running from source). */
function currentBuild(file = BUILD_JSON, fallbackVersion = '') {
  try {
    const b = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { version: String(b.version ?? fallbackVersion), build: String(b.build ?? ''), commit: String(b.commit ?? ''), builtAt: String(b.builtAt ?? '') };
  } catch {
    return { version: fallbackVersion, build: '', commit: '', builtAt: '' };
  }
}

/** Is `latest` newer than `current`? Compares the `build` ids (UTC yyyymmddHHMMSS); unknown current = older. */
function isNewer(latest, current) {
  const l = latest && typeof latest.build === 'string' ? latest.build : '';
  const c = current && typeof current.build === 'string' ? current.build : '';
  if (!/^\d+$/.test(l)) return false;
  if (!/^\d+$/.test(c)) return true;
  return BigInt(l) > BigInt(c);
}

/** /Applications/Alfred.app/Contents/MacOS/Alfred → /Applications/Alfred.app (null when not inside a .app). */
function bundlePathFrom(exePath) {
  if (typeof exePath !== 'string' || !path.isAbsolute(exePath)) return null;
  const macos = path.dirname(exePath);
  const contents = path.dirname(macos);
  const bundle = path.dirname(contents);
  if (path.basename(macos) !== 'MacOS' || path.basename(contents) !== 'Contents' || !bundle.endsWith('.app')) return null;
  return bundle;
}

/** Single-quote a string for bash: 'it'\''s'. NUL cannot be represented and is refused. */
function shq(s) {
  const str = String(s);
  if (str.includes('\0')) throw new Error('NUL in shell argument');
  return `'${str.replace(/'/g, `'\\''`)}'`;
}

/** CFBundleIdentifier from a bundle's Info.plist (XML as written by @electron/packager). */
function readBundleId(appPath, execFileSync = require('node:child_process').execFileSync) {
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  const text = fs.readFileSync(plist);
  const m = /<key>\s*CFBundleIdentifier\s*<\/key>\s*<string>([^<]*)<\/string>/.exec(text.toString('utf8'));
  if (m) return m[1].trim();
  if (process.platform === 'darwin') {
    // binary plist: let plutil read it
    return String(execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist], { encoding: 'utf8' })).trim();
  }
  return null;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * Download the zip from `<conf.url>/api/v1/app/download` into `dir`, then verify sha256 === latest.sha256.
 * Throws (and deletes the file) on a mismatch — nothing is unpacked from an unverified file.
 */
async function download({ conf, latest, dir, fetch = globalThis.fetch, timeoutMs = 15 * 60_000 }) {
  if (!conf || !conf.url) throw new Error('no server URL configured');
  if (!latest || !/^[0-9a-f]{64}$/.test(String(latest.sha256 || ''))) throw new Error('latest.json has no valid sha256');
  const url = new URL('/api/v1/app/download', conf.url); // always the configured origin
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  const file = path.join(dir, 'Alfred-mac-arm64.zip');
  try {
    const res = await fetch(url.href, {
      headers: conf.token ? { authorization: `Bearer ${conf.token}` } : {},
      redirect: 'error',
      signal: ctl.signal,
    });
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
    const header = res.headers && typeof res.headers.get === 'function' ? res.headers.get('x-sha256') : null;
    if (header && header !== latest.sha256) throw new Error('the server is serving a different build than it announced; check again');
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file, { mode: 0o600 }));
  } catch (e) {
    fs.rmSync(file, { force: true });
    if (e && e.name === 'AbortError') throw new Error('download timed out');
    throw e;
  } finally {
    clearTimeout(t);
  }
  const got = await sha256File(file);
  if (got !== latest.sha256) {
    fs.rmSync(file, { force: true });
    throw new Error(`sha256 mismatch: expected ${latest.sha256.slice(0, 12)}…, got ${got.slice(0, 12)}… — refusing to install`);
  }
  return file;
}

/**
 * The bash helper that swaps bundles after this process exits. Every path is single-quoted (shq).
 * mode 'update': NEW → TARGET, old TARGET → TARGET.previous (the older .previous dropped on success).
 * mode 'rollback': TARGET.previous ↔ TARGET.
 * The script refuses to run unless TARGET ends in .app and PREV is exactly TARGET.previous.
 */
function helperScript({ pid, target, source, mode = 'update', log, cleanup }) {
  if (!Number.isInteger(pid) || pid <= 1) throw new Error('bad pid');
  if (typeof target !== 'string' || !path.isAbsolute(target) || !target.endsWith('.app')) throw new Error('target must be an absolute .app path');
  const prev = `${target}.previous`;
  if (mode === 'rollback') source = prev;
  else if (mode !== 'update') throw new Error(`bad mode: ${mode}`);
  if (typeof source !== 'string' || !path.isAbsolute(source)) throw new Error('source must be an absolute path');
  if (cleanup !== undefined && (typeof cleanup !== 'string' || !path.isAbsolute(cleanup) || cleanup === target || target.startsWith(`${cleanup}/`))) throw new Error('bad cleanup dir');
  if (mode === 'update' && (source === target || source === prev || source.startsWith(`${target}/`))) throw new Error('source must be a new bundle');
  return `#!/bin/bash
# Alfred self-update helper (generated; runs once and deletes itself).
set -u
PID=${pid}
TARGET=${shq(target)}
SOURCE=${shq(source)}
PREV=${shq(prev)}
MODE=${shq(mode)}
LOG=${shq(log || '/dev/null')}
CLEAN=${cleanup ? shq(cleanup) : "''"}
SELF="$0"
exec >>"$LOG" 2>&1
echo "$(date -u +%FT%TZ) $MODE: waiting for pid $PID"
case "$TARGET" in *.app) ;; *) echo "refusing: $TARGET is not an .app"; exit 1 ;; esac
[ "$PREV" = "$TARGET.previous" ] || { echo "refusing: unexpected backup path"; exit 1; }
[ -d "$SOURCE" ] || { echo "refusing: $SOURCE is missing"; exit 1; }
[ "$SOURCE" != "$TARGET" ] || { echo "refusing: source is the target"; exit 1; }
for _ in $(seq 1 240); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
if kill -0 "$PID" 2>/dev/null; then echo "app did not quit; nothing changed"; exit 1; fi
sleep 1
ASIDE="$TARGET.updating-$$"
restore() {
  echo "failed: $1 — restoring the previous bundle"
  if [ -e "$TARGET" ]; then
    if [ "$MODE" = rollback ] && [ ! -e "$PREV" ]; then mv "$TARGET" "$PREV"; else rm -rf "$TARGET"; fi
  fi
  mv "$ASIDE" "$TARGET" || echo "could not restore; the old bundle is at $ASIDE"
  if [ "$MODE" = update ] && [ -e "$PREV.old-$$" ]; then rm -rf "$PREV"; mv "$PREV.old-$$" "$PREV"; fi
  open "$TARGET"
  finish 1
}
finish() {
  [ -n "$CLEAN" ] && rm -rf "$CLEAN"
  rm -f "$SELF"; rmdir "$(dirname "$SELF")" 2>/dev/null
  exit "$1"
}
mv "$TARGET" "$ASIDE" || { echo "cannot move $TARGET aside; nothing changed"; open "$TARGET"; finish 1; }
if [ "$MODE" = update ]; then
  if [ -e "$PREV" ]; then mv "$PREV" "$PREV.old-$$" || restore "keep old backup"; fi
  mv "$SOURCE" "$TARGET" || restore "move new bundle"
else
  mv "$PREV" "$TARGET" || restore "move previous bundle"
fi
xattr -cr "$TARGET" || restore "xattr"
codesign --force --deep --sign - "$TARGET" || restore "codesign"
mv "$ASIDE" "$PREV" || echo "warning: could not keep $ASIDE as $PREV"
[ "$MODE" = update ] && rm -rf "$PREV.old-$$"
echo "$(date -u +%FT%TZ) $MODE: done"
open "$TARGET"
finish 0
`;
}

/** Write the helper to a private temp file and start it detached (it outlives this app). */
function launchHelper(script, { spawn = realSpawn, tmp = os.tmpdir() } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'alfred-update-helper-'));
  const file = path.join(dir, 'swap.sh');
  fs.writeFileSync(file, script, { mode: 0o700 });
  const child = spawn('/bin/bash', [file], { detached: true, stdio: 'ignore' });
  child.unref();
  return file;
}

function execFileP(execFile, cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5 * 60_000 }, (err, _stdout, stderr) => (err ? reject(new Error(`${cmd} failed: ${String(stderr || err.message).trim()}`)) : resolve()));
  });
}

/**
 * The full update. deps: { conf: () => {url, token}, latest, exePath, bundleId, platform, pid, logFile,
 *   fetch?, execFile?, spawn?, quit(), tmp?, onStatus?(text) }. Returns { ok, error? } (it only returns ok
 *   after the helper is spawned and quit() was called).
 */
async function installUpdate(d) {
  const say = (t) => {
    try {
      d.onStatus?.(t);
    } catch {
      /* ignore */
    }
  };
  if ((d.platform ?? process.platform) !== 'darwin') return { ok: false, error: 'updates are for macOS' };
  const target = bundlePathFrom(d.exePath);
  if (!target) return { ok: false, error: 'not running from an Alfred.app bundle (running from source?)' };
  let work = null;
  try {
    work = fs.mkdtempSync(path.join(d.tmp ?? os.tmpdir(), 'alfred-update-'));
    say('Downloading…');
    const zip = await download({ conf: d.conf(), latest: d.latest, dir: work, fetch: d.fetch });
    say('Verified. Unpacking…');
    const out = path.join(work, 'unzipped');
    fs.mkdirSync(out);
    await execFileP(d.execFile ?? realExecFile, '/usr/bin/ditto', ['-x', '-k', zip, out]);
    const fresh = path.join(out, 'Alfred.app');
    if (!fs.existsSync(path.join(fresh, 'Contents', 'Info.plist'))) throw new Error('the download has no Alfred.app');
    const id = readBundleId(fresh);
    if (!id || id !== d.bundleId) throw new Error(`the new bundle is ${id || 'unidentified'}, not ${d.bundleId}; refusing`);
    fs.rmSync(zip, { force: true });
    const script = helperScript({ pid: d.pid ?? process.pid, target, source: fresh, mode: 'update', log: d.logFile, cleanup: work });
    launchHelper(script, { spawn: d.spawn, tmp: d.tmp });
    say('Installing — Alfred will restart…');
    d.quit();
    return { ok: true };
  } catch (e) {
    if (work) fs.rmSync(work, { recursive: true, force: true });
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/** The kept previous bundle, when there is one. */
function previousBundle(exePath) {
  const target = bundlePathFrom(exePath);
  if (!target) return null;
  const prev = `${target}.previous`;
  return fs.existsSync(path.join(prev, 'Contents', 'Info.plist')) ? prev : null;
}

/** Swap back to Alfred.app.previous (same helper, mode rollback). */
function rollback(d) {
  if ((d.platform ?? process.platform) !== 'darwin') return { ok: false, error: 'updates are for macOS' };
  const target = bundlePathFrom(d.exePath);
  if (!target || !previousBundle(d.exePath)) return { ok: false, error: 'no previous version to roll back to' };
  try {
    const id = readBundleId(`${target}.previous`);
    if (id !== d.bundleId) return { ok: false, error: `the previous bundle is ${id || 'unidentified'}; refusing` };
    launchHelper(helperScript({ pid: d.pid ?? process.pid, target, mode: 'rollback', log: d.logFile }), { spawn: d.spawn, tmp: d.tmp });
    d.quit();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

module.exports = {
  BUILD_JSON,
  CHECK_EVERY_MS,
  currentBuild,
  isNewer,
  bundlePathFrom,
  shq,
  readBundleId,
  sha256File,
  download,
  helperScript,
  launchHelper,
  installUpdate,
  previousBundle,
  rollback,
};
