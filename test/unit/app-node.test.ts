// P18 unit test: the bundled alfred-node, spawned exactly as the app does (the Electron binary with
// ELECTRON_RUN_AS_NODE=1, no PATH lookups), connects to a real server and stops on demand.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { startAlfred, type Alfred } from '../../src/main.js';
import type { LLM } from '../../src/runtime/contract.js';

const require = createRequire(import.meta.url);
const APP = resolve('app');
const ELECTRON = join(APP, 'node_modules/electron/dist/electron');
const { createNodeRunner, SCRIPT } = require(join(APP, 'src/node.cjs'));

const idle: LLM = { async chat() { return { content: '', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 } }; } };

let alfred: Alfred;
let base: string;

beforeAll(async () => {
  execFileSync(process.execPath, [join(APP, 'scripts/build-node.mjs')], { stdio: 'inherit' });
  base = mkdtempSync(join(tmpdir(), 'alfred-app-node-'));
  alfred = await startAlfred({ dbPath: join(base, 'a.db'), mirrorDir: join(base, 'vault'), workRoot: join(base, 'work'), personasDir: 'personas',
    port: 0, host: '127.0.0.1', pollMs: 25, deck: null, token: 'node-token', env: { ALFRED_NOTIFY_DESKTOP: '0' }, llm: idle, gitRoot: join(base, 'git') });
}, 120_000);

afterAll(async () => { await alfred?.stop(); });

const nodes = () => fetch(`${alfred.url}/api/v1/nodes`, { headers: { authorization: 'Bearer node-token' } }).then((r) => r.json());
async function until<T>(fn: () => Promise<T>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 100)); }
}

describe.skipIf(!existsSync(ELECTRON))('embedded node', () => {
  it('connects via ELECTRON_RUN_AS_NODE and stops when disabled', async () => {
    expect(existsSync(SCRIPT)).toBe(true);
    const root = join(base, 'root');
    mkdirSync(root);
    const states: any[] = [];
    const runner = createNodeRunner({ execPath: ELECTRON, logFile: join(base, 'node.log'), onState: (s: any) => states.push(s) });
    const s = { url: alfred.url, token: 'node-token', node: { enabled: true, name: 'unit-mac', roots: [root], dsh: false } };
    runner.apply(s);
    const list = await until(async () => { const l = await nodes(); return l.some((n: any) => n.name === 'unit-mac') && l; });
    expect(list.find((n: any) => n.name === 'unit-mac').roots).toEqual([root]);
    expect(states.at(-1)).toMatchObject({ name: 'unit-mac', running: true });
    runner.apply({ ...s, node: { ...s.node, enabled: false } });
    await until(async () => !(await nodes()).some((n: any) => n.name === 'unit-mac'));
    expect(runner.state()).toBeNull();
  }, 60_000);
});
