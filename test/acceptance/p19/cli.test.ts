// P19 acceptance — written by the orchestrator. Do not edit to make it pass.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, statSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { startAlfred, type Alfred } from '../../../src/main.js';
import type { LLM, LLMRequest } from '../../../src/runtime/contract.js';

const run = promisify(execFile);
const CLI = resolve('src/cli.ts');
const TSX = resolve('node_modules/.bin/tsx');

let alfred: Alfred;
let home: string;
let env: Record<string, string>;

/** Chat replies with a fixed text; everything else idles. */
const llm: LLM = {
  async chat(req: LLMRequest) {
    const u = { promptTokens: 1, completionTokens: 1 };
    if (req.system.includes('chief of staff') && req.tools.some(t => t.name === 'start_goal')) return { content: 'All quiet, Quinn.', toolCalls: [], usage: u };
    await new Promise((r, j) => { const t = setTimeout(r, 60_000); req.signal?.addEventListener('abort', () => { clearTimeout(t); j(Object.assign(new Error('aborted'), { name: 'AbortError' })); }); });
    return { content: '', toolCalls: [], usage: u };
  },
};

async function cli(args: string[], extraEnv: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await run(TSX, [CLI, ...args], { env: { ...env, ...extraEnv }, timeout: 60_000 });
    return { code: 0, out: stdout, err: stderr };
  } catch (e: any) {
    return { code: e.code ?? 1, out: e.stdout ?? '', err: e.stderr ?? '' };
  }
}

beforeAll(async () => {
  const base = mkdtempSync(join(tmpdir(), 'alfred-cli-'));
  home = join(base, 'home');
  mkdirSync(home);
  alfred = await startAlfred({ dbPath: join(base, 'a.db'), mirrorDir: join(base, 'vault'), workRoot: join(base, 'work'), personasDir: 'personas',
    port: 0, host: '127.0.0.1', pollMs: 25, deck: null, token: 'cli-token', env: { ALFRED_NOTIFY_DESKTOP: '0' }, llm, gitRoot: join(base, 'git'),
    extra: { llm } });
  env = { PATH: process.env.PATH!, HOME: home, ALFRED_CLI_CONFIG: join(home, 'cli.json') };
}, 60_000);
afterAll(async () => { await alfred?.stop(); });

describe('connection', () => {
  it('logs in, stores a private config, and uses it', async () => {
    const bad = await cli(['status']);
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/^alfred: /);
    const login = await cli(['login', '--url', alfred.url, '--token', 'cli-token']);
    expect(login.code).toBe(0);
    expect(login.out).toContain(`ok: ${alfred.url}`);
    const cfgPath = join(home, 'cli.json');
    expect(JSON.parse(readFileSync(cfgPath, 'utf8'))).toEqual({ url: alfred.url, token: 'cli-token' });
    expect(statSync(cfgPath).mode & 0o777).toBe(0o600);
    expect((await cli(['status'])).code).toBe(0);
    const unknown = await cli(['frobnicate']);
    expect(unknown.code).toBe(2);
  }, 60_000);
});

describe('board', () => {
  it('adds, lists, shows, moves, edits, comments, completes and sends items', async () => {
    const add = await cli(['add', 'Renew passport', '--prio', 'high', '--label', 'home', '--due', '2026-10-02', '--status', 'todo']);
    expect(add.out).toMatch(/created ALF-1/);
    await cli(['add', 'Fix the gutter', '--assign', 'quinn']);
    const board = await cli(['board']);
    expect(board.out).toMatch(/== To do \(1\)/);
    expect(board.out).toMatch(/ALF-1 \(high\) Renew passport/);
    expect(board.out).toContain('due:2026-10-02');
    const mine = await cli(['board', '--mine']);
    expect(mine.out).toContain('Fix the gutter');
    expect(mine.out).not.toContain('Renew passport');
    expect((await cli(['mv', 'ALF-1', 'doing'])).out).toContain('ALF-1 → In progress');
    expect((await cli(['edit', 'ALF-1', '--title', 'Renew passports'])).out).toContain('updated ALF-1');
    expect((await cli(['comment', 'ALF-1', 'photos are in the drawer'])).out).toContain('commented on ALF-1');
    const item = await cli(['item', 'alf-1']);
    expect(item.out).toMatch(/ALF-1 \[In progress\] Renew passports/);
    expect(item.out).toContain('quinn: photos are in the drawer');
    const sent = await cli(['send', 'ALF-2', '--persona', 'coder', '--check', 'ok=true']);
    expect(sent.out).toMatch(/sent ALF-2 → goal \S+ \(coder\)/);
    expect((await cli(['done', 'ALF-1'])).out).toContain('ALF-1 → Done');
    const json = await cli(['board', '--json']);
    expect(Array.isArray(JSON.parse(json.out))).toBe(true);
  }, 120_000);
});

describe('goals, inbox, chat, review, stats', () => {
  it('shows the inbox, asks alfred, and reads review/transcript output', async () => {
    const g = alfred.store.createGoal({ title: 'CLI parked goal' });
    const t = alfred.store.createTask({ goalId: g.id, persona: 'researcher', title: 'CLI parked task' });
    alfred.store.claim(t.id, 'w', 60_000);
    alfred.store.transition(t.id, 'blocked', { reason: 'approval needed: git push', by: 'w' });
    const ap = alfred.store.requestApproval(t.id, 'git push', 'git push origin main');
    alfred.store.appendEvent(g.id, t.id, 'turn', { turn: 1, text: 'pushing now', calls: [{ name: 'run_shell', args: '{"cmd":"git push"}' }], usage: { promptTokens: 1, completionTokens: 1 } });
    const inbox = await cli(['inbox']);
    expect(inbox.out).toContain('Approvals');
    expect(inbox.out).toContain(ap.id.slice(0, 8));
    expect(inbox.out).toContain('CLI parked task');
    const ask = await cli(['ask', 'anything going on?']);
    expect(ask.out).toContain('All quiet, Quinn.');
    const tr = await cli(['transcript', t.id]);
    expect(tr.out).toContain('turn 1: pushing now');
    expect(tr.out).toContain('run_shell');
    const diff = await cli(['diff', g.slug]);
    expect(diff.code).toBe(0);
    const stats = await cli(['stats']);
    expect(stats.out).toMatch(/^Tasks/m);
    expect(stats.out).toMatch(/^Tokens 24h/m);
    const approve = await cli(['approve', ap.id]);
    expect(approve.code).toBe(0);
    expect(alfred.store.approvals({ status: 'approved' }).map(a => a.id)).toContain(ap.id);
  }, 120_000);

  it('refuses mutating ops without --yes when not a terminal; config get works', async () => {
    const svc = await cli(['svc', 'restart', 'qwen-server']);
    expect(svc.code).toBe(1);
    expect(svc.err).toContain('--yes');
    const cfg = await cli(['config', 'ls']);
    expect(cfg.out).toContain('personas/coder.yaml');
    const get = await cli(['config', 'get', 'personas/coder.yaml']);
    expect(get.out).toContain('name: coder');
    const open = await cli(['open', 'ALF-1', '--print']);
    expect(open.out.trim()).toBe(`${alfred.url}/#/board/ALF-1`);
  }, 60_000);
});

describe('bundle', () => {
  it('builds a single-file CLI that runs without node_modules', async () => {
    execFileSync('npm', ['run', 'build:cli'], { stdio: 'pipe' });
    expect(existsSync('dist/alfred.mjs')).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'alfred-bundle-'));
    copyFileSync('dist/alfred.mjs', join(dir, 'alfred.mjs'));
    const { stdout } = await run('node', [join(dir, 'alfred.mjs'), 'status'], { cwd: dir, env: { ...env }, timeout: 30_000 });
    expect(stdout).toContain('CLI parked goal');
    const help = await run('node', [join(dir, 'alfred.mjs'), '--help'], { cwd: dir, env: { ...env } });
    expect(help.stdout).toContain('board');
  }, 120_000);
});
