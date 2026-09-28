import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  bwrapSelfTest,
  configureSandbox,
  isSecretEnvKey,
  sandboxSpawnArgs,
  sandboxedCommand,
  scrubEnv,
} from '../../src/sandbox.js';
import { builtinTools } from '../../src/runtime/tools.js';
import type { ToolContext } from '../../src/runtime/contract.js';
import { LocalBackend, NodeHub } from '../../src/node/hub.js';
import { guardRoot } from '../../src/node/protocol.js';
import { connectNode, execArgv, macSandboxProfile, MAC_DENY_HOME } from '../../src/node/client.js';
import { startBridge } from '../../src/executors/langgraph.js';
import { defaultRunner } from '../../src/gate.js';

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const HAVE_BWRAP = bwrapSelfTest() === null;

afterAll(() => {
  configureSandbox({ mode: 'off', env: {} });
});

describe('scrubEnv', () => {
  it('drops Alfred/Slack/LLM/GitHub secrets and secret-named keys, keeps the basics', () => {
    const env = scrubEnv({
      PATH: '/usr/bin', HOME: '/home/x', LANG: 'C.UTF-8', TERM: 'xterm', USER: 'q',
      ALFRED_TOKEN: 't', ALFRED_PORT: '1', SLACK_BOT_TOKEN: 's', SLACK_APP_TOKEN: 's',
      TWILIO_SID: 'x', ANTHROPIC_API_KEY: 'k', OPENAI_BASE_URL: 'u', GITHUB_TOKEN: 'g',
      GH_TOKEN: 'g', NPM_TOKEN: 'n', MY_SECRET: 'x', db_password: 'p', FOO_APIKEY: 'k',
      QWEN_FLASH_API_KEY: 'k', SSH_PRIVATE_KEY: 'k', AWS_CREDENTIALS: 'c', PGPASSWD: 'p',
      UNDEF: undefined,
    });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/x', LANG: 'C.UTF-8', TERM: 'xterm', USER: 'q' });
    expect(isSecretEnvKey('NODE_OPTIONS')).toBe(false);
    expect(isSecretEnvKey('slack_whatever')).toBe(true);
  });
});

describe('sandboxSpawnArgs', () => {
  it('builds the bwrap policy: ro root, private /tmp, hidden home, allowlist, git hub hooks ro', () => {
    const home = tmp('sb-home-');
    for (const d of ['.cache', '.local/bin', '.config', '.ssh', '.dsh']) mkdirSync(join(home, d), { recursive: true });
    writeFileSync(join(home, '.gitconfig'), '[user]\n');
    writeFileSync(join(home, '.dsh', '.credentials.yaml'), 'secret');
    const hub = join(home, '.alfred', 'git');
    mkdirSync(join(hub, 'p.git', 'hooks'), { recursive: true });
    writeFileSync(join(hub, 'p.git', 'config'), '');
    const ws = tmp('sb-ws-');
    mkdirSync(join(ws, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(ws, '.git', 'config'), '');

    const { file, args } = sandboxSpawnArgs(['bash', '-c', 'true'], { workspace: ws, home, gitHub: hub, bwrap: '/x/bwrap' });
    expect(file).toBe('/x/bwrap');
    const s = args.join(' ');
    expect(s.startsWith('--ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --unshare-pid --unshare-ipc --die-with-parent --new-session')).toBe(true);
    expect(s).not.toContain('--unshare-net');
    expect(s).toContain(`--tmpfs ${home}`);
    expect(s).toContain(`--bind ${ws} ${ws}`);
    expect(s).toContain(`--ro-bind ${home}/.gitconfig ${home}/.gitconfig`);
    expect(s).toContain(`--ro-bind ${home}/.local/bin ${home}/.local/bin`);
    expect(s).toContain(`--bind ${home}/.cache ${home}/.cache`);
    expect(s).toContain(`--bind ${hub} ${hub}`);
    expect(s).toContain(`--ro-bind ${hub}/p.git/hooks ${hub}/p.git/hooks`);
    expect(s).toContain(`--ro-bind ${hub}/p.git/config ${hub}/p.git/config`);
    expect(s).toContain(`--ro-bind ${ws}/.git/hooks ${ws}/.git/hooks`);
    expect(s).toContain(`--ro-bind /dev/null ${home}/.dsh/.credentials.yaml`);
    expect(s).not.toContain(`${home}/.config`);
    expect(s).not.toContain(`${home}/.ssh`);
    // parents before children; the hub's ro hooks after the hub bind
    expect(s.indexOf(`--bind ${hub} `)).toBeLessThan(s.indexOf(`${hub}/p.git/hooks`));
    expect(args.slice(-6)).toEqual(['--chdir', ws, '--', 'bash', '-c', 'true']);

    const noNet = sandboxSpawnArgs(['true'], { workspace: ws, home, network: false }).args;
    expect(noNet).toContain('--unshare-net');
  });

  it('binds a linked worktree\'s common git dir rw with its hooks/config read-only', () => {
    const home = tmp('sb-home-');
    const repo = tmp('sb-repo-');
    const r = spawnSync('git', ['init', '-q', repo]);
    expect(r.status).toBe(0);
    spawnSync('git', ['-C', repo, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'x']);
    const wt = join(repo, '.alfred-worktrees', 'w1');
    expect(spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'b1', wt, 'HEAD']).status).toBe(0);
    const s = sandboxSpawnArgs(['true'], { workspace: wt, home }).args.join(' ');
    expect(s).toContain(`--bind ${repo}/.git ${repo}/.git`);
    expect(s).toContain(`--ro-bind ${repo}/.git/hooks ${repo}/.git/hooks`);
    expect(s).toContain(`--ro-bind ${repo}/.git/config ${repo}/.git/config`);
  });

  it('sandbox off: runs the command itself, env still scrubbed', () => {
    const sc = sandboxedCommand('bash', ['-c', 'env'], { workspace: '/tmp', mode: 'off', env: { PATH: '/bin', ALFRED_TOKEN: 'x' } });
    expect(sc.file).toBe('bash');
    expect(sc.sandboxed).toBe(false);
    expect(sc.env).toEqual({ PATH: '/bin' });
  });
});

describe.skipIf(!HAVE_BWRAP)('bwrap end-to-end', () => {
  const run = (script: string, o: { workspace: string; home?: string }) => {
    const { file, args } = sandboxSpawnArgs(['bash', '-c', script], { workspace: o.workspace, ...(o.home ? { home: o.home } : {}) });
    return spawnSync(file, args, {
      env: scrubEnv({ ...process.env, ALFRED_TOKEN: 'sekrit-token', HOME: o.home ?? process.env.HOME }),
      encoding: 'utf8',
      timeout: 20_000,
    });
  };

  it('hides a secret in a fake home, hides the parent\'s /proc environ, allows workspace writes and toolchains', () => {
    const home = tmp('sb-fakehome-');
    mkdirSync(join(home, '.config'), { recursive: true });
    writeFileSync(join(home, '.config', 'alfred.env'), 'ALFRED_TOKEN=fake-secret-123\n');
    mkdirSync(join(home, '.alfred'), { recursive: true });
    writeFileSync(join(home, '.alfred', 'alfred.db'), 'db');
    const ws = tmp('sb-e2e-ws-');
    const other = tmp('sb-other-');
    writeFileSync(join(other, 'loot'), 'x');

    const r = run(
      [
        `cat ${home}/.config/alfred.env && echo LEAK1`,
        `cat ${home}/.alfred/alfred.db && echo LEAK2`,
        `cat ${other}/loot && echo LEAK3`,
        `cat /proc/${process.pid}/environ && echo LEAK4`,
        `env | grep -q sekrit && echo LEAK5`,
        `echo hi > ${ws}/made && echo WROTE`,
        `node -v >/dev/null && echo NODE_OK`,
        `git --version >/dev/null && echo GIT_OK`,
        `echo pid=$$`,
      ].join('; '),
      { workspace: ws, home },
    );
    expect(r.stdout).not.toMatch(/LEAK|fake-secret/);
    expect(r.stdout).toContain('WROTE');
    expect(r.stdout).toContain('NODE_OK');
    expect(r.stdout).toContain('GIT_OK');
    expect(readFileSync(join(ws, 'made'), 'utf8')).toBe('hi\n');
  });

  it('with the real home: ~/.config, ~/.ssh, ~/.alfred/alfred.db, /run/user are invisible (existence only)', () => {
    const ws = tmp('sb-e2e-ws2-');
    const h = homedir();
    const r = run(
      [
        `test -e ${h}/.config && echo SEE_CONFIG`,
        `test -e ${h}/.ssh && echo SEE_SSH`,
        `test -e ${h}/.alfred/alfred.db && echo SEE_DB`,
        `test -e ${h}/repos && echo SEE_REPOS`,
        `test -S /run/user/$(id -u)/bus && echo SEE_BUS`,
        `touch ${h}/.gitconfig 2>/dev/null && echo WRITE_GITCONFIG`,
        'echo done',
      ].join('; '),
      { workspace: ws },
    );
    expect(r.stdout.trim()).toBe('done');
  });

  it('run_shell under the sandbox: no token, no home secrets, workspace writable', async () => {
    configureSandbox({ mode: 'bwrap', env: {} });
    try {
      const shell = builtinTools({ approvals: false }).find((t) => t.schema.name === 'run_shell')!;
      const ws = tmp('sb-shell-');
      const prev = process.env.ALFRED_TOKEN;
      process.env.ALFRED_TOKEN = 'sekrit-token';
      try {
        const res = await shell.run(
          { cmd: `env | grep -c sekrit; test -e ${homedir()}/.config && echo SEE; echo ok > f; cat f` },
          ctx(ws),
        );
        expect(res.output).toMatch(/^0\n/);
        expect(res.output).not.toContain('SEE');
        expect(res.output).toContain('ok');
        // LocalBackend (the path real tasks take) too
        const lb = await new LocalBackend().exec(`env | grep -c sekrit; test -e ${homedir()}/.config && echo SEE; pwd`, { cwd: ws, timeoutMs: 10_000 });
        expect(lb.output).toMatch(/^0\n/);
        expect(lb.output).not.toContain('SEE');
        expect(lb.output).toContain(ws);
        // acceptance gate
        const g = await defaultRunner({ name: 'c', cmd: `test ! -e ${homedir()}/.config && env | grep -vq sekrit`, cwd: ws }, { workspace: ws });
        expect(g.ok).toBe(true);
        // timeouts still kill the sandboxed tree
        const t0 = Date.now();
        const slow = await new LocalBackend().exec('sleep 30', { cwd: ws, timeoutMs: 300 });
        expect(slow.timedOut).toBe(true);
        expect(Date.now() - t0).toBeLessThan(5000);
      } finally {
        if (prev === undefined) delete process.env.ALFRED_TOKEN;
        else process.env.ALFRED_TOKEN = prev;
      }
    } finally {
      configureSandbox({ mode: 'off', env: {} });
    }
  }, 30_000);

  it('nested bwrap (DSH\'s own sandbox) works inside ours', () => {
    const ws = tmp('sb-nest-');
    const r = run('bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --unshare-pid -- echo nested-ok', { workspace: ws });
    expect(r.stdout).toContain('nested-ok');
  });
});

function ctx(workspace: string, over: Partial<ToolContext> = {}): ToolContext {
  return {
    taskId: 't', goalId: 'g', workspace, persona: 'coder',
    signal: new AbortController().signal, acceptance: [], progress: () => {}, ...over,
  };
}

describe('symlink escapes', () => {
  const tools = () => {
    const all = builtinTools({ approvals: false });
    const get = (n: string) => all.find((t) => t.schema.name === n)!;
    return { read: get('read_file'), write: get('write_file'), list: get('list_dir') };
  };

  for (const backed of [false, true]) {
    it(`read/write/list refuse symlinks out of the workspace${backed ? ' (LocalBackend)' : ''}`, async () => {
      const ws = tmp('sl-ws-');
      const out = tmp('sl-out-');
      writeFileSync(join(out, 'secret'), 'TOPSECRET');
      symlinkSync(join(out, 'secret'), join(ws, 'link'));
      symlinkSync(out, join(ws, 'dirlink'));
      symlinkSync(join(out, 'newfile'), join(ws, 'dangling'));
      symlinkSync(join(ws, 'real.txt'), join(ws, 'inlink'));
      writeFileSync(join(ws, 'real.txt'), 'fine');
      const c = ctx(ws, backed ? { backend: new LocalBackend() } : {});
      const { read, write, list } = tools();

      const r1 = await read.run({ path: 'link' }, c);
      expect(r1.ok).toBe(false);
      expect(r1.output).not.toContain('TOPSECRET');
      expect((await read.run({ path: 'dirlink/secret' }, c)).ok).toBe(false);
      expect((await list.run({ path: 'dirlink' }, c)).ok).toBe(false);
      expect((await write.run({ path: 'dangling', content: 'x' }, c)).ok).toBe(false);
      expect(existsSync(join(out, 'newfile'))).toBe(false);
      expect((await write.run({ path: 'dirlink/new', content: 'x' }, c)).ok).toBe(false);
      expect(existsSync(join(out, 'new'))).toBe(false);
      expect((await write.run({ path: 'link', content: 'x' }, c)).ok).toBe(false);
      expect(readFileSync(join(out, 'secret'), 'utf8')).toBe('TOPSECRET');
      expect((await read.run({ path: '../' + out.split('/').pop() + '/secret' }, c)).ok).toBe(false);
      // In-workspace symlinks and plain files keep working
      expect((await read.run({ path: 'inlink' }, c)).output).toContain('fine');
      expect((await write.run({ path: 'sub/dir/a.txt', content: 'A' }, c)).ok).toBe(true);
      expect(readFileSync(join(ws, 'sub/dir/a.txt'), 'utf8')).toBe('A');
      expect((await list.run({}, c)).ok).toBe(true);
    });
  }

  it('node guardRoot refuses symlink escapes, dangling links, and writes through a final symlink', () => {
    const root = tmp('sl-root-');
    const out = tmp('sl-out2-');
    symlinkSync(out, join(root, 'esc'));
    symlinkSync(join(out, 'nothere'), join(root, 'dang'));
    writeFileSync(join(root, 'ok'), '');
    symlinkSync(join(root, 'ok'), join(root, 'okl'));
    expect(guardRoot([root], join(root, 'esc/x'))).toBeNull();
    expect(guardRoot([root], join(root, 'dang'))).toBeNull();
    expect(guardRoot([root], join(root, 'dang'), { write: true })).toBeNull();
    expect(guardRoot([root], join(root, 'okl'))).toBe(join(root, 'ok'));
    expect(guardRoot([root], join(root, 'okl'), { write: true })).toBeNull();
    expect(guardRoot([root], join(root, 'new/deep.txt'), { write: true })).toBe(join(root, 'new/deep.txt'));
    expect(guardRoot([root], '/etc/passwd')).toBeNull();
  });
});

describe('langgraph file bridge', () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  const post = (url: string, headers: Record<string, string>, body = '{"op":"read","path":"a.txt"}') =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const u = new URL(url + '/fs');
      const req = request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
      });
      req.on('error', reject);
      req.end(body);
    });

  it('requires the per-run secret, a JSON content-type and the exact Host', async () => {
    const ws = tmp('lg-ws-');
    const backend = {
      node: 'mac',
      readFile: async () => 'CONTENT',
      writeFile: async () => {},
      listDir: async () => [],
      exec: async () => ({ exitCode: 0, output: '', timedOut: false }),
    };
    const b = await startBridge(ctx(ws, { backend }));
    close = b.close;
    const host = new URL(b.url).host;
    const json = { 'content-type': 'application/json', host };
    expect((await post(b.url, json)).status).toBe(401);
    expect((await post(b.url, { ...json, authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await post(b.url, { ...json, authorization: `Bearer ${b.secret}`, host: 'evil.example:80' })).status).toBe(403);
    expect((await post(b.url, { authorization: `Bearer ${b.secret}`, host, 'content-type': 'text/plain' })).status).toBe(415);
    const ok = await post(b.url, { ...json, authorization: `Bearer ${b.secret}` });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ ok: true, text: 'CONTENT' });
    expect(b.secret).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('Mac node exec', () => {
  it('generates the sandbox-exec argv and profile (paths as -D params)', () => {
    const [file, argv] = execArgv('echo hi', { roots: ['/Users/q/code', '/Users/q/w'], home: '/Users/q', platform: 'darwin', sandboxExec: '/usr/bin/sandbox-exec' });
    expect(file).toBe('/usr/bin/sandbox-exec');
    expect(argv.slice(0, 6)).toEqual(['-D', 'HOME=/Users/q', '-D', 'ROOT0=/Users/q/code', '-D', 'ROOT1=/Users/q/w']);
    expect(argv.slice(-3)).toEqual(['/bin/bash', '-c', 'echo hi']);
    const profile = argv[argv.indexOf('-p') + 1]!;
    expect(profile).toBe(macSandboxProfile(2));
    expect(profile).toContain('(allow default)');
    expect(profile).toMatch(/\(deny file-read\* file-write\*/);
    for (const rel of MAC_DENY_HOME) expect(profile).toContain(`(string-append (param "HOME") "/${rel}")`);
    expect(profile).toContain('(subpath (param "ROOT0"))');
    expect(profile).toContain('(subpath (param "ROOT1"))');
    expect(profile).toContain('(subpath "/private/var/folders")');
    expect(profile).toContain('(subpath "/tmp")');
    expect(profile).not.toContain('/Users/q');
    // Linux, or sandbox-exec missing: plain bash
    expect(execArgv('x', { roots: [], home: '/h', platform: 'linux' })).toEqual(['bash', ['-c', 'x']]);
    expect(execArgv('x', { roots: [], home: '/h', platform: 'darwin', sandboxExec: null })).toEqual(['bash', ['-c', 'x']]);
  });

  it('exec children do not inherit the node\'s ALFRED_TOKEN', async () => {
    const hub = new NodeHub({ token: 'tok', callTimeoutMs: 5000 });
    const srv: Server = createServer((_q, s) => { s.statusCode = 404; s.end(); });
    hub.attach(srv);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const root = tmp('node-env-');
    const prev = process.env.ALFRED_TOKEN;
    process.env.ALFRED_TOKEN = 'node-sekrit';
    process.env.SLACK_BOT_TOKEN = 'slack-sekrit';
    const n = connectNode({ url: `ws://127.0.0.1:${(srv.address() as any).port}`, token: 'tok', name: 'lap', roots: [root], reconnect: false });
    try {
      for (let i = 0; i < 100 && !hub.list().some((x) => x.name === 'lap'); i++) await new Promise((r) => setTimeout(r, 30));
      const r = await hub.backend('lap').exec('env', { cwd: root, timeoutMs: 5000 });
      expect(r.exitCode).toBe(0);
      expect(r.output).toContain('PATH=');
      expect(r.output).not.toContain('sekrit');
    } finally {
      n.close();
      hub.close();
      srv.close();
      if (prev === undefined) delete process.env.ALFRED_TOKEN;
      else process.env.ALFRED_TOKEN = prev;
      delete process.env.SLACK_BOT_TOKEN;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('config', () => {
  it('serveConfig (production) asks for bwrap; ALFRED_SANDBOX overrides', async () => {
    const { serveConfig } = await import('../../src/main.js');
    expect(serveConfig({}).sandbox).toBe('bwrap');
    const log: string[] = [];
    const prev = process.env.ALFRED_SANDBOX;
    delete process.env.ALFRED_SANDBOX;
    try {
      expect(configureSandbox({ mode: 'bwrap', env: { ALFRED_SANDBOX: 'off' }, log: (m) => log.push(m) }).mode).toBe('off');
      expect(configureSandbox({ env: {} }).requested).toBe('off');
    } finally {
      if (prev !== undefined) process.env.ALFRED_SANDBOX = prev;
      configureSandbox({ mode: 'off', env: {} });
    }
  });
});
