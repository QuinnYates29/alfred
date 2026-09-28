// P18 unit tests: the app's pure modules (settings, SSE parsing, quick add, tray state, node argv).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const APP = resolve('app');
const settings = require(join(APP, 'src/settings.cjs'));
const { parseSSE, backoffMs, createApi } = require(join(APP, 'src/api.cjs'));
const { parseQuick, submitQuick } = require(join(APP, 'src/quick.cjs'));
const { computeState, buildMenu, titleFor } = require(join(APP, 'src/tray.cjs'));
const { nodeArgs, wsUrl } = require(join(APP, 'src/node.cjs'));
const { decide } = require(join(APP, 'src/notify.cjs'));

const dir = () => mkdtempSync(join(tmpdir(), 'alfred-app-unit-'));

describe('settings', () => {
  it('round-trips with 0600 and falls back to defaults on a missing or corrupt file', () => {
    const d = dir();
    expect(settings.load(d, null)).toEqual(settings.defaults());
    settings.save({ url: 'http://h:1/', token: 'sekrit', notify: { done: true }, node: { enabled: true, roots: ['/a', ' ', 7] } }, d, null);
    expect(statSync(join(d, 'settings.json')).mode & 0o777).toBe(0o600);
    const s = settings.load(d, null);
    expect(s).toMatchObject({ url: 'http://h:1', token: 'sekrit', notify: { failures: true, done: true }, node: { enabled: true, name: 'macbook', roots: ['/a'] } });
    writeFileSync(join(d, 'settings.json'), '{not json');
    expect(settings.load(d, null)).toEqual(settings.defaults());
  });

  it('stores the token encrypted when safeStorage is available', () => {
    const d = dir();
    const fake = {
      encryptString: (t: string) => Buffer.from([...t].reverse().join('')),
      decryptString: (b: Buffer) => [...b.toString()].reverse().join(''),
    };
    settings.save({ url: 'https://x', token: 'abc123' }, d, fake);
    const raw = JSON.parse(readFileSync(join(d, 'settings.json'), 'utf8'));
    expect(raw.token).toBeUndefined();
    expect(raw.tokenEnc).toBe(Buffer.from('321cba').toString('base64'));
    expect(settings.load(d, fake).token).toBe('abc123');
    // Keychain refuses (re-signed app): token comes back empty so Settings asks again.
    expect(settings.load(d, { decryptString: () => { throw new Error('denied'); } }).token).toBe('');
    expect(settings.load(d, null).token).toBe('');
  });
});

describe('api', () => {
  it('parses SSE frames, comments and partial frames', () => {
    const { events, rest } = parseSSE(': open\n\nid: 5\ndata: {"a":1}\n\n: ping\n\nid: 6\r\ndata: {"b"');
    expect(events).toEqual([{ id: '5', data: '{"a":1}' }]);
    expect(rest).toBe('id: 6\ndata: {"b"');
    expect([0, 1, 2, 5, 9].map(backoffMs)).toEqual([1000, 2000, 4000, 30_000, 30_000]);
  });

  it('sends the bearer token and surfaces server errors', async () => {
    const seen: any[] = [];
    const fetch = async (url: string, init: any) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ error: 'nope' }), { status: 409 });
    };
    const api = createApi(() => ({ url: 'http://s', token: 't0k' }), { fetch });
    await expect(api.request('POST', '/api/v1/x', { a: 1 })).rejects.toThrow('nope');
    expect(seen[0].url).toBe('http://s/api/v1/x');
    expect(seen[0].init.headers.authorization).toBe('Bearer t0k');
  });
});

describe('quick add', () => {
  it('handles edge cases of the grammar', () => {
    expect(parseQuick('!! urgent-ish thing')).toMatchObject({ kind: 'item', title: 'urgent-ish thing', priority: 'high' });
    expect(parseQuick('!')).toEqual({ kind: 'none' });
    expect(parseQuick('?')).toEqual({ kind: 'none' });
    expect(parseQuick('#only #labels')).toEqual({ kind: 'none' });
    expect(parseQuick('x !!! !!')).toMatchObject({ priority: 'urgent' });
    expect(parseQuick('ship it', new Date(2026, 11, 31))).toEqual({ kind: 'item', title: 'ship it' });
    expect(parseQuick('ship it @tomorrow', new Date(2026, 11, 31)).due).toBe('2027-01-01');
  });

  it('submits each kind and formats the result line', async () => {
    const calls: any[] = [];
    const api = {
      async request(method: string, path: string, body: any) {
        calls.push({ method, path, body });
        if (path === '/api/v1/items') return { key: 'ALF-7' };
        if (path === '/api/v1/dispatch') return { persona: 'alfred', goal: { slug: 'g-1' } };
        if (path === '/api/v1/chat') return { reply: { content: 'y'.repeat(300) } };
        throw new Error('boom');
      },
    };
    expect(await submitQuick('Buy milk #home !!', api)).toBe('Created ALF-7');
    expect(calls[0].body).toEqual({ title: 'Buy milk', labels: ['home'], priority: 'high' });
    expect(await submitQuick('! do the thing', api)).toBe('Started alfred → g-1');
    expect(calls[1]).toEqual({ method: 'POST', path: '/api/v1/dispatch', body: { text: '! do the thing', source: 'mac-quick' } });
    expect((await submitQuick('? hi', api)).length).toBe(200);
    expect(await submitQuick('', api)).toMatch(/^⚠/);
    const failing = { request: async () => { throw new Error('offline'); } };
    expect(await submitQuick('x', failing)).toBe('⚠ offline');
  });
});

describe('tray + notify', () => {
  it('computes state from goal summaries', () => {
    const s = computeState({
      live: true,
      goals: [
        { id: 'a', title: 'A', status: 'active', counts: { running: 2, verifying: 1 } },
        { id: 'b', title: 'B', status: 'active', counts: { needs_claude: 1 } },
        { id: 'c', title: 'C', status: 'failed', counts: { failed: 1 } },
      ],
      approvals: [{ id: 'p', action: 'git push', detail: 'd', extra: 1 }],
      stats: null,
    });
    expect(s).toMatchObject({ running: 3, parked: 1, attention: 3, attentionGoals: [{ id: 'b' }, { id: 'c', status: 'failed' }] });
    expect(titleFor(s)).toBe('3');
    expect(titleFor({ ...s, live: false })).toBe('!');
    const clicks: string[] = [];
    const menu = buildMenu(s, { open: (r: string) => clicks.push(r), decide: (id: string, d: string) => clicks.push(`${id}:${d}`) });
    const approvals = menu.find((m: any) => m.label === 'Approvals');
    approvals.submenu[0].submenu[1].click();
    menu.find((m: any) => m.label === 'Needs attention').submenu[1].click();
    expect(clicks).toEqual(['p:denied', '/goal/c']);
  });

  it('decides goal failures and clips long titles', () => {
    const ctx = { settings: { notify: { failures: true } }, goalTitle: () => 'G'.repeat(300), taskTitle: () => undefined, windowFocused: false };
    const n = decide({ id: 1, goalId: 'g', taskId: null, ts: 0, kind: 'goal_status', data: { status: 'failed' } }, ctx);
    expect(n.title.startsWith('Goal failed: G')).toBe(true);
    expect(n.title.length).toBeLessThanOrEqual(200);
    expect(decide({ id: 2, goalId: 'g', taskId: 't', ts: 0, kind: 'transition', data: { to: 'blocked', reason: 'r' } }, ctx).title.startsWith('Blocked: G')).toBe(true);
    expect(decide({ id: 3, goalId: '', taskId: null, ts: 0, kind: 'item_created', data: {} }, ctx)).toBeNull();
  });
});

describe('node argv', () => {
  it('derives the ws url and passes roots/dsh', () => {
    expect(wsUrl('https://gx10.tail.ts.net:8443/')).toBe('wss://gx10.tail.ts.net:8443');
    expect(wsUrl('http://127.0.0.1:8790')).toBe('ws://127.0.0.1:8790');
    const args = nodeArgs({ url: 'https://h:8443', token: 'T', node: { name: 'mac', roots: ['/a', '/b'], dsh: true } }, '/x/alfred-node.mjs');
    expect(args).toEqual(['/x/alfred-node.mjs', '--server', 'wss://h:8443', '--name', 'mac', '--root', '/a', '--root', '/b', '--dsh', '--no-notify']);
  });
});
