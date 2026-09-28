// SC hygiene: token compare, Host allow-list, CSP/security headers, SSE tickets, token-required startup.
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/store.js';
import { createApp, safeEqual as appSafeEqual } from '../../src/server/app.js';
import {
  safeEqual, hostAllowed, hostnameOf, allowedHostsFromEnv, contentSecurityPolicy, TicketBook,
} from '../../src/server/security.js';
import { startAlfred } from '../../src/main.js';

const TS = 'gx10-de9a.tail542084.ts.net';

function req(port: number, path: string, o: { method?: string; headers?: Record<string, string>; body?: string; abortAfterHeaders?: boolean } = {}):
  Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method: o.method ?? 'GET', headers: o.headers ?? {} }, (res) => {
      if (o.abortAfterHeaders) {
        resolve({ status: res.statusCode!, headers: res.headers, body: '' });
        res.destroy();
        r.destroy();
        return;
      }
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    r.on('error', (e: any) => (o.abortAfterHeaders && e.code === 'ECONNRESET' ? undefined : reject(e)));
    if (o.body) r.write(o.body);
    r.end();
  });
}

let servers: http.Server[] = [];
afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
});
async function listen(app: any): Promise<number> {
  const s: http.Server = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  servers.push(s);
  return (s.address() as any).port;
}

describe('safeEqual', () => {
  it('compares in constant time over digests', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
    expect(safeEqual(undefined, 'x')).toBe(false);
    expect(appSafeEqual).toBe(safeEqual);
  });
});

describe('Host allow-list', () => {
  const allowed = allowedHostsFromEnv({ ALFRED_DASHBOARD_URL: `https://${TS}:8443`, ALFRED_ALLOWED_HOSTS: 'alfred.lan, other.example:9000' }, '127.0.0.1');
  it('parses host headers', () => {
    expect(hostnameOf('[::1]:8790')).toBe('::1');
    expect(hostnameOf('Localhost:8790')).toBe('localhost');
    expect(hostnameOf(`${TS}:8443`)).toBe(TS);
  });
  it('allows loopback, IP literals, the dashboard host and ALFRED_ALLOWED_HOSTS', () => {
    for (const h of ['127.0.0.1:8790', 'localhost:8790', '[::1]:8790', `${TS}:8443`, TS, 'alfred.lan', 'other.example:9000', '10.0.0.22:8790', '100.64.1.2']) {
      expect(hostAllowed(h, allowed), h).toBe(true);
    }
  });
  it('rejects everything else (DNS rebinding)', () => {
    for (const h of ['evil.com', 'evil.com:8790', `${TS}.evil.com`, 'localhost.evil.com', '', undefined]) {
      expect(hostAllowed(h as any, allowed), String(h)).toBe(false);
    }
  });
  it('is enforced by createApp with 421', async () => {
    const store = openStore(':memory:');
    const port = await listen(createApp({ store, token: 't0k3n-long', allowedHosts: [TS] }));
    const auth = { authorization: 'Bearer t0k3n-long' };
    expect((await req(port, '/api/v1/health', { headers: { ...auth, host: 'evil.com' } })).status).toBe(421);
    expect((await req(port, '/api/v1/health', { headers: { ...auth, host: `${TS}:8443` } })).status).toBe(200);
    expect((await req(port, '/api/v1/health', { headers: { ...auth, host: `127.0.0.1:${port}` } })).status).toBe(200);
    expect((await req(port, '/', { headers: { host: 'evil.com' } })).status).toBe(421);
  });
});

describe('CSP and security headers', () => {
  it('builds a strict policy that frames only the Deck', () => {
    const csp = contentSecurityPolicy('http://127.0.0.1:8787');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toMatch(/frame-src 'self' http:\/\/127\.0\.0\.1:8787 http:\/\/localhost:8787/);
    expect(contentSecurityPolicy(null)).toContain("frame-src 'self';");
  });
  it('is sent on API and dashboard responses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sc-static-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>x</title>');
    const store = openStore(':memory:');
    const port = await listen(createApp({ store, token: 'tok-12345', staticDir: dir, deckUrl: 'http://127.0.0.1:8787' }));
    for (const path of ['/', '/api/v1/health?token=tok-12345', '/api/v1/health']) {
      const r = await req(port, path);
      expect(r.headers['content-security-policy'], path).toContain("frame-ancestors 'none'");
      expect(r.headers['content-security-policy'], path).toContain('http://127.0.0.1:8787');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
      expect(r.headers['x-frame-options']).toBe('DENY');
    }
  });
});

describe('SSE tickets', () => {
  it('TicketBook: single use, expires after the TTL', () => {
    let now = 1000;
    const book = new TicketBook(60_000, () => now);
    const a = book.issue().ticket;
    expect(book.consume(a)).toBe(true);
    expect(book.consume(a)).toBe(false);
    const b = book.issue().ticket;
    now += 60_001;
    expect(book.consume(b)).toBe(false);
    expect(book.consume('nope')).toBe(false);
    expect(book.consume(undefined)).toBe(false);
  });
  it('POST /events/ticket (bearer) → one /api/events stream; reuse and bad tickets are 401', async () => {
    const store = openStore(':memory:');
    const port = await listen(createApp({ store, token: 'tok-12345' }));
    expect((await req(port, '/api/v1/events/ticket', { method: 'POST' })).status).toBe(401);
    const t = await req(port, '/api/v1/events/ticket', { method: 'POST', headers: { authorization: 'Bearer tok-12345' } });
    expect(t.status).toBe(200);
    const { ticket } = JSON.parse(t.body);
    expect(typeof ticket).toBe('string');
    const first = await req(port, `/api/events?since=0&ticket=${ticket}`, { abortAfterHeaders: true });
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toContain('text/event-stream');
    expect((await req(port, `/api/events?since=0&ticket=${ticket}`)).status).toBe(401);
    // A ticket opens only the event stream.
    const t2 = JSON.parse((await req(port, '/api/events/ticket', { method: 'POST', headers: { authorization: 'Bearer tok-12345' } })).body).ticket;
    expect((await req(port, `/api/v1/goals?ticket=${t2}`)).status).toBe(401);
    // Legacy ?token= still works (Mac app compat); a wrong token doesn't.
    expect((await req(port, '/api/v1/goals?token=tok-12345')).status).toBe(200);
    expect((await req(port, '/api/v1/goals?token=tok-12346')).status).toBe(401);
  });
});

describe('a token is always required outside tests', () => {
  const saved = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = saved;
  });
  it('createApp without a token refuses /api and /mcp unless allowNoToken', async () => {
    process.env.NODE_ENV = 'production';
    const store = openStore(':memory:');
    const port = await listen(createApp({ store, door: (() => ({})) as any }));
    const r = await req(port, '/api/v1/health');
    expect(r.status).toBe(401);
    expect(r.body).toMatch(/no token/);
    expect((await req(port, '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
    const open = await listen(createApp({ store, allowNoToken: true }));
    expect((await req(open, '/api/v1/health')).status).toBe(200);
  });
  it('startAlfred refuses to start tokenless (even on loopback) unless allowNoToken', async () => {
    process.env.NODE_ENV = 'production';
    const base = mkdtempSync(join(tmpdir(), 'sc-start-'));
    mkdirSync(join(base, 'w'));
    const common = { dbPath: join(base, 'a.db'), mirrorDir: join(base, 'v'), workRoot: join(base, 'w'), personasDir: 'personas', port: 0,
      host: '127.0.0.1', deck: null, env: { ALFRED_NOTIFY_DESKTOP: '0' }, gitRoot: join(base, 'git'), modules: [], builtins: [], pluginDirs: [] } as any;
    await expect(startAlfred(common)).rejects.toThrow(/token/i);
  });
});

describe('web captureToken', () => {
  it('stores the token and strips ?token= from the address bar, keeping other params and the hash', async () => {
    // @ts-expect-error web/src/api.js is plain JS with no type declarations (runtime-checked here)
    const { captureToken } = await import('../../web/src/api.js');
    const saved: Record<string, string> = {};
    const store = { setItem: (k: string, v: string) => { saved[k] = v; } };
    const calls: any[] = [];
    const hist = { state: { s: 1 }, replaceState: (...a: any[]) => calls.push(a) };
    captureToken({ search: '?token=abc&x=1', pathname: '/', hash: '#/goal/g1' } as any, hist as any, store as any);
    expect(saved['alfred.token']).toBe('abc');
    expect(calls).toEqual([[{ s: 1 }, '', '/?x=1#/goal/g1']]);
    calls.length = 0;
    captureToken({ search: '', pathname: '/', hash: '#/' } as any, hist as any, store as any);
    expect(calls).toEqual([]);
    captureToken({ search: '?token=zzz', pathname: '/', hash: '' } as any, hist as any, store as any);
    expect(calls).toEqual([[{ s: 1 }, '', '/']]);
  });
});
