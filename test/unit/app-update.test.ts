// U1 unit tests — the Mac app's self-update: build metadata, version comparison, download verification,
// the bundle-swap helper script (run for real under bash with stub xattr/codesign/open), cli.json, LaunchAgent.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
// @ts-expect-error — plain ESM script without types
import { buildId, gitCommit, makeBuildInfo, makeLatest, writeJson } from '../../app/scripts/latest.mjs';

const require = createRequire(import.meta.url);
const APP = resolve('app');
const up = require(join(APP, 'src/update.cjs'));
const mac = require(join(APP, 'src/mac-setup.cjs'));
const { buildMenu, computeState } = require(join(APP, 'src/tray.cjs'));
const settings = require(join(APP, 'src/settings.cjs'));

const tmp = (p = 'u1') => mkdtempSync(join(tmpdir(), `alfred-${p}-`));
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

describe('latest.json generation', () => {
  it('build ids are UTC yyyymmddHHMMSS and increase with time', () => {
    expect(buildId(new Date('2026-09-28T03:04:05Z'))).toBe('20260928030405');
    expect(BigInt(buildId(new Date('2026-09-28T03:04:06Z')))).toBeGreaterThan(BigInt(buildId(new Date('2026-09-28T03:04:05Z'))));
  });

  it('marks a dirty tree and survives no git', () => {
    const fake = (dirty: boolean) => (args: string[]) => (args[0] === 'rev-parse' ? 'abc1234\n' : dirty ? ' M x\n' : '');
    expect(gitCommit('/r', fake(false))).toBe('abc1234');
    expect(gitCommit('/r', fake(true))).toBe('abc1234-dirty');
    expect(gitCommit('/r', () => { throw new Error('no git'); })).toBe('unknown');
    expect(gitCommit(resolve('.'))).toMatch(/^[0-9a-f]{7,}(-dirty)?$/);
  });

  it('describes the zip with sha256 + size', () => {
    const d = tmp();
    const zip = join(d, 'Alfred-mac-arm64.zip');
    writeFileSync(zip, 'zipbytes');
    const info = makeBuildInfo({ version: '0.1.0', commit: 'abc1234', now: new Date('2026-09-28T00:00:00Z') });
    const latest = makeLatest(info, zip);
    expect(latest).toEqual({ version: '0.1.0', build: '20260928000000', sha256: sha('zipbytes'), size: 8, builtAt: '2026-09-28T00:00:00.000Z', commit: 'abc1234' });
    writeJson(join(d, 'latest.json'), latest);
    expect(JSON.parse(readFileSync(join(d, 'latest.json'), 'utf8'))).toEqual(latest);
    expect(readdirSync(d).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('version comparison', () => {
  it('compares build ids numerically; unknown current is older; bad latest never wins', () => {
    expect(up.isNewer({ build: '20260928000001' }, { build: '20260928000000' })).toBe(true);
    expect(up.isNewer({ build: '20260928000000' }, { build: '20260928000000' })).toBe(false);
    expect(up.isNewer({ build: '20260927235959' }, { build: '20260928000000' })).toBe(false);
    expect(up.isNewer({ build: '20260928000000' }, { build: '' })).toBe(true);
    expect(up.isNewer({ build: 'x' }, { build: '1' })).toBe(false);
    expect(up.isNewer(null, { build: '1' })).toBe(false);
  });

  it('reads the bundled build.json, falling back to the package version', () => {
    const d = tmp();
    const f = join(d, 'build.json');
    expect(up.currentBuild(f, '0.1.0')).toEqual({ version: '0.1.0', build: '', commit: '', builtAt: '' });
    writeFileSync(f, JSON.stringify({ version: '0.2.0', build: '20260101000000', commit: 'abc', builtAt: 'x' }));
    expect(up.currentBuild(f, '0.1.0')).toMatchObject({ version: '0.2.0', build: '20260101000000' });
  });

  it('finds the .app from the executable path', () => {
    expect(up.bundlePathFrom('/Applications/Alfred.app/Contents/MacOS/Alfred')).toBe('/Applications/Alfred.app');
    expect(up.bundlePathFrom('/Users/q/My Apps/Alfred.app/Contents/MacOS/Alfred')).toBe('/Users/q/My Apps/Alfred.app');
    expect(up.bundlePathFrom('/home/q/app/node_modules/electron/dist/electron')).toBeNull();
    expect(up.bundlePathFrom('Alfred.app/Contents/MacOS/Alfred')).toBeNull();
  });
});

describe('download', () => {
  const body = Buffer.from('the zip');
  const latest = { build: '20260928000000', sha256: sha(body) };
  const fetchOf = (bytes: Buffer, headers: Record<string, string> = {}, seen: any[] = []) =>
    (async (url: string, init: any) => {
      seen.push({ url, init });
      return new Response(new Uint8Array(bytes), { status: 200, headers });
    }) as any;

  it('fetches from the configured origin with the token and verifies sha256', async () => {
    const seen: any[] = [];
    const d = tmp();
    const file = await up.download({ conf: { url: 'https://spark:8443/', token: 'tok' }, latest, dir: d, fetch: fetchOf(body, {}, seen) });
    expect(readFileSync(file)).toEqual(body);
    expect(seen[0].url).toBe('https://spark:8443/api/v1/app/download');
    expect(seen[0].init.headers.authorization).toBe('Bearer tok');
    expect(seen[0].init.redirect).toBe('error');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('refuses (and deletes the file) on a sha256 mismatch', async () => {
    const d = tmp();
    await expect(up.download({ conf: { url: 'https://spark', token: 't' }, latest, dir: d, fetch: fetchOf(Buffer.from('tampered')) }))
      .rejects.toThrow(/sha256 mismatch/);
    expect(readdirSync(d)).toEqual([]);
  });

  it('refuses when the server announces a different sha, or latest has none', async () => {
    const d = tmp();
    await expect(up.download({ conf: { url: 'https://spark', token: 't' }, latest, dir: d, fetch: fetchOf(body, { 'x-sha256': 'f'.repeat(64) }) }))
      .rejects.toThrow(/different build/);
    await expect(up.download({ conf: { url: 'https://spark', token: 't' }, latest: { build: '1', sha256: '' }, dir: d, fetch: fetchOf(body) }))
      .rejects.toThrow(/sha256/);
    await expect(up.download({ conf: { url: 'https://spark', token: 't' }, latest, dir: d, fetch: (async () => new Response('no', { status: 401 })) as any }))
      .rejects.toThrow(/HTTP 401/);
    expect(readdirSync(d)).toEqual([]);
  });

  it('installUpdate is macOS-only and never unpacks an unverified download', async () => {
    const quit = () => { throw new Error('must not quit'); };
    expect(await up.installUpdate({ platform: 'linux', quit })).toEqual({ ok: false, error: 'updates are for macOS' });
    const execs: any[] = [];
    const r = await up.installUpdate({
      platform: 'darwin', exePath: '/Applications/Alfred.app/Contents/MacOS/Alfred', bundleId: 'net.popotomodem.alfred',
      conf: () => ({ url: 'https://spark', token: 't' }), latest, fetch: fetchOf(Buffer.from('evil')), tmp: tmp(),
      execFile: (...a: any[]) => execs.push(a), spawn: () => { throw new Error('must not spawn'); }, quit,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/sha256 mismatch/);
    expect(execs).toEqual([]);
  });

  it('refuses a verified bundle with a different CFBundleIdentifier', async () => {
    const t = tmp();
    const r = await up.installUpdate({
      platform: 'darwin', exePath: '/Applications/Alfred.app/Contents/MacOS/Alfred', bundleId: 'net.popotomodem.alfred',
      conf: () => ({ url: 'https://spark', token: 't' }), latest, fetch: fetchOf(body), tmp: t,
      // fake ditto: "unpacks" a bundle with someone else's id
      execFile: (_cmd: string, args: string[], _o: any, cb: any) => {
        const out = args[args.length - 1];
        mkdirSync(join(out, 'Alfred.app', 'Contents'), { recursive: true });
        writeFileSync(join(out, 'Alfred.app', 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleIdentifier</key><string>com.evil</string></dict></plist>');
        cb(null, '', '');
      },
      spawn: () => { throw new Error('must not spawn'); }, quit: () => { throw new Error('must not quit'); },
    });
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toMatch(/com\.evil/);
    expect(readdirSync(t)).toEqual([]); // work dir cleaned up
  });

  it('spawns the helper detached and quits after a good download', async () => {
    const t = tmp();
    const spawned: any[] = [];
    let quits = 0;
    const r = await up.installUpdate({
      platform: 'darwin', exePath: '/Applications/Alfred.app/Contents/MacOS/Alfred', bundleId: 'net.popotomodem.alfred', pid: 4242,
      conf: () => ({ url: 'https://spark', token: 't' }), latest, fetch: fetchOf(body), tmp: t,
      execFile: (_cmd: string, args: string[], _o: any, cb: any) => {
        const out = args[args.length - 1];
        mkdirSync(join(out, 'Alfred.app', 'Contents'), { recursive: true });
        writeFileSync(join(out, 'Alfred.app', 'Contents', 'Info.plist'), '<key>CFBundleIdentifier</key>\n<string>net.popotomodem.alfred</string>');
        cb(null, '', '');
      },
      spawn: (cmd: string, args: string[], o: any) => { spawned.push({ cmd, args, o }); return { unref() {} }; },
      quit: () => { quits++; },
    });
    expect(r).toEqual({ ok: true });
    expect(quits).toBe(1);
    expect(spawned[0].cmd).toBe('/bin/bash');
    expect(spawned[0].o).toMatchObject({ detached: true, stdio: 'ignore' });
    const script = readFileSync(spawned[0].args[0], 'utf8');
    expect(script).toContain("TARGET='/Applications/Alfred.app'");
    expect(script).toContain('PID=4242');
  });
});

describe('helper script', () => {
  it('quotes paths with spaces, quotes and $ safely', () => {
    expect(up.shq("it's")).toBe(`'it'\\''s'`);
    const target = `/tmp/My "Apps" $HOME it's/Alfred.app`;
    const s = up.helperScript({ pid: 99999, target, source: '/tmp/x y/Alfred.app', log: '/tmp/l og' });
    // bash parses the assignments back to exactly the input strings
    const out = execFileSync('/bin/bash', ['-c', `${s.split('\n').filter((l: string) => /^(TARGET|SOURCE|PREV)=/.test(l)).join('\n')}\nprintf '%s\\n' "$TARGET" "$SOURCE" "$PREV"`], { encoding: 'utf8' });
    expect(out).toBe(`${target}\n/tmp/x y/Alfred.app\n${target}.previous\n`);
  });

  it('refuses anything but an absolute .app target and a separate source', () => {
    expect(() => up.helperScript({ pid: 5, target: '/Users/q', source: '/tmp/A.app' })).toThrow(/\.app/);
    expect(() => up.helperScript({ pid: 5, target: 'Alfred.app', source: '/tmp/A.app' })).toThrow(/\.app/);
    expect(() => up.helperScript({ pid: 5, target: '/A/Alfred.app', source: '/A/Alfred.app' })).toThrow(/new bundle/);
    expect(() => up.helperScript({ pid: 5, target: '/A/Alfred.app', source: '/A/Alfred.app.previous' })).toThrow(/new bundle/);
    expect(() => up.helperScript({ pid: 0, target: '/A/Alfred.app', source: '/tmp/A.app' })).toThrow(/pid/);
    expect(() => up.helperScript({ pid: 5, target: '/A/Alfred.app', source: '/tmp/A\0.app' })).toThrow(/NUL/);
  });

  // Runs the real script with stub xattr/codesign/open on PATH.
  function world(opts: { codesignFails?: boolean } = {}) {
    const base = join(tmp('u1-swap'), `dir with 'quote' and "dq"`);
    const bin = join(base, 'bin');
    mkdirSync(bin, { recursive: true });
    const calls = join(base, 'calls.log');
    for (const [name, code] of [['xattr', 0], ['codesign', opts.codesignFails ? 1 : 0], ['open', 0]] as const) {
      writeFileSync(join(bin, name), `#!/bin/bash\necho "${name} $*" >> ${up.shq(calls)}\nexit ${code}\n`);
      chmodSync(join(bin, name), 0o755);
    }
    const mk = (p: string, v: string) => { mkdirSync(join(p, 'Contents'), { recursive: true }); writeFileSync(join(p, 'Contents', 'v'), v); };
    const apps = join(base, 'Applications');
    const target = join(apps, 'Alfred.app');
    mk(target, 'old');
    const work = join(base, 'work');
    const source = join(work, 'unzipped', 'Alfred.app');
    mk(source, 'new');
    const run = (script: string) => {
      const f = join(base, 'helper', 'swap.sh');
      mkdirSync(join(base, 'helper'), { recursive: true });
      writeFileSync(f, script);
      return spawnSync('/bin/bash', [f], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8', timeout: 20_000 });
    };
    const ver = (p: string) => (existsSync(join(p, 'Contents', 'v')) ? readFileSync(join(p, 'Contents', 'v'), 'utf8') : null);
    const deadPid = () => { const c = spawnSync('true'); return c.pid!; };
    return { base, apps, target, source, work, run, ver, calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8') : ''), mk, deadPid, log: join(base, 'update.log') };
  }

  it('swaps in the new bundle, keeps the old one as .previous, signs and relaunches', () => {
    const w = world();
    w.mk(`${w.target}.previous`, 'older');
    const r = w.run(up.helperScript({ pid: w.deadPid(), target: w.target, source: w.source, log: w.log, cleanup: w.work }));
    expect(r.status).toBe(0);
    expect(w.ver(w.target)).toBe('new');
    expect(w.ver(`${w.target}.previous`)).toBe('old');
    expect(readdirSync(w.apps).sort()).toEqual(['Alfred.app', 'Alfred.app.previous']);
    expect(w.calls()).toBe(`xattr -cr ${w.target}\ncodesign --force --deep --sign - ${w.target}\nopen ${w.target}\n`);
    expect(existsSync(w.work)).toBe(false);
    expect(existsSync(join(w.base, 'helper'))).toBe(false); // deleted itself
    expect(readFileSync(w.log, 'utf8')).toMatch(/update: done/);

    // …and rolls back: the two swap places
    const rb = w.run(up.helperScript({ pid: w.deadPid(), target: w.target, mode: 'rollback', log: w.log }));
    expect(rb.status).toBe(0);
    expect(w.ver(w.target)).toBe('old');
    expect(w.ver(`${w.target}.previous`)).toBe('new');
  });

  it('restores the old bundle (and the older backup) when signing fails', () => {
    const w = world({ codesignFails: true });
    w.mk(`${w.target}.previous`, 'older');
    const r = w.run(up.helperScript({ pid: w.deadPid(), target: w.target, source: w.source, log: w.log }));
    expect(r.status).toBe(1);
    expect(w.ver(w.target)).toBe('old');
    expect(w.ver(`${w.target}.previous`)).toBe('older');
    expect(readdirSync(w.apps).sort()).toEqual(['Alfred.app', 'Alfred.app.previous']);
    expect(w.calls()).toMatch(/open .*Alfred\.app\n$/);
    expect(readFileSync(w.log, 'utf8')).toMatch(/failed: codesign/);
  });

  it('a failed rollback keeps both bundles', () => {
    const w = world({ codesignFails: true });
    w.mk(`${w.target}.previous`, 'older');
    const r = w.run(up.helperScript({ pid: w.deadPid(), target: w.target, mode: 'rollback', log: w.log }));
    expect(r.status).toBe(1);
    expect(w.ver(w.target)).toBe('old');
    expect(w.ver(`${w.target}.previous`)).toBe('older');
  });

  it('does nothing while the app is still running', () => {
    const w = world();
    const s = up.helperScript({ pid: process.pid, target: w.target, source: w.source, log: w.log }).replace('seq 1 240', 'seq 1 2');
    const r = w.run(s);
    expect(r.status).toBe(1);
    expect(w.ver(w.target)).toBe('old');
    expect(w.ver(w.source)).toBe('new');
    expect(w.calls()).toBe('');
  });
});

describe('token once: cli.json and the LaunchAgent', () => {
  it('writes cli.json in the `alfred login` format with mode 0600 (also over an existing 0644 file)', () => {
    const d = tmp();
    const f = join(d, '.config', 'alfred', 'cli.json');
    mkdirSync(join(d, '.config', 'alfred'), { recursive: true });
    writeFileSync(f, '{}', { mode: 0o644 });
    mac.writeCliConfig('https://spark:8443/', 'sekrit', f);
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ url: 'https://spark:8443', token: 'sekrit' });
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  it('installs the bundled CLI and its config', () => {
    const home = tmp();
    const src = join(home, 'alfred.mjs');
    writeFileSync(src, '#!/usr/bin/env node\n');
    const out = mac.installCli({ src, url: 'https://s', token: 't', home });
    expect(statSync(out.bin).mode & 0o777).toBe(0o755);
    expect(statSync(out.config).mode & 0o777).toBe(0o600);
    expect(() => mac.installCli({ src: join(home, 'nope'), url: 'https://s', token: 't', home })).toThrow(/not bundled/);
  });

  it('reads the LaunchAgent args and disables it (unload + .disabled)', async () => {
    const home = tmp();
    const plist = mac.launchAgentPath(home);
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(plist, `<plist><dict><key>ProgramArguments</key><array>
  <string>/usr/local/bin/node</string><string>client.ts</string><string>--server</string><string>wss://x</string>
  <string>--name</string><string>macbook</string><string>--token</string><string>t</string>
  <string>--root</string><string>/Users/q/code &amp; stuff</string><string>--dsh</string></array></dict></plist>`);
    expect(mac.launchAgentInfo(home)).toMatchObject({ plist, name: 'macbook', roots: ['/Users/q/code & stuff'], dsh: true, messages: false });
    const calls: any[] = [];
    const r = await mac.disableLaunchAgent({ home, execFile: (cmd: string, args: string[], _o: any, cb: any) => { calls.push([cmd, ...args]); cb(null, '', ''); } });
    expect(r).toEqual({ ok: true, disabled: `${plist}.disabled` });
    expect(calls).toEqual([['/bin/launchctl', 'unload', plist]]);
    expect(existsSync(plist)).toBe(false);
    expect(existsSync(`${plist}.disabled`)).toBe(true);
    expect(mac.launchAgentInfo(home)).toBeNull();
    expect(await mac.disableLaunchAgent({ home })).toMatchObject({ ok: false });
  });
});

describe('settings + tray', () => {
  it('auto-check defaults on and round-trips; a keychain failure flags the lost token', () => {
    const d = tmp();
    expect(settings.defaults().updates).toEqual({ auto: true });
    settings.save({ url: 'https://x', token: 't', updates: { auto: false } }, d, null);
    expect(settings.load(d, null).updates).toEqual({ auto: false });
    const fake = { encryptString: (t: string) => Buffer.from(t), decryptString: () => { throw new Error('denied'); } };
    settings.save({ url: 'https://x', token: 't' }, d, fake);
    const s = settings.load(d, fake);
    expect(s).toMatchObject({ token: '', tokenLost: true });
    expect(settings.isConfigured(s)).toBe(false); // → the settings window opens asking for it
    expect(settings.merge(s).tokenLost).toBeUndefined(); // never persisted
  });

  it('the tray offers the update when one is available', () => {
    const base = { goals: [], approvals: [], stats: null, live: true, paused: false, node: null };
    expect(buildMenu(computeState(base)).map((i: any) => i.label)).not.toContain(expect.stringMatching(/Update available/));
    let clicked = 0;
    const menu = buildMenu(computeState({ ...base, update: { version: '0.1.0', build: '2' } }), { installUpdate: () => clicked++ });
    const item = menu.find((i: any) => /^Update available — install/.test(i.label ?? ''));
    expect(item).toBeTruthy();
    item.click();
    expect(clicked).toBe(1);
  });
});
