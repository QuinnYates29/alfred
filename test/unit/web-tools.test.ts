// W1 — unit tests for the web tools. No real internet: local http servers + fetchImpl stubs.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import type { ToolContext } from '../../src/runtime/contract.js';
import { isBlockedAddress, checkUrl, htmlToText, parseDdgHtml, webFetchTool, webSearchTool } from '../../src/runtime/web.js';
import { toolCaps, denies } from '../../src/runtime/caps.js';
import { builtinTools } from '../../src/runtime/tools.js';

const ctx = (): ToolContext => ({
  taskId: 't',
  goalId: 'g',
  workspace: process.cwd(),
  persona: 'researcher',
  signal: new AbortController().signal,
  acceptance: [],
  progress: () => {},
});

const PAGE = `<!doctype html><html><head><title>My &amp; Page</title><style>body{color:SHOULD_NOT_APPEAR}</style></head>
<body><nav><a href="/home">HomeLink</a></nav>
<script>var secret = "SHOULD_NOT_APPEAR";</script>
<h1>Hello World</h1>
<p>Intro &amp; details with&nbsp;spaces.</p>
<ul><li>Alpha</li><li>Beta &lt;tag&gt;</li></ul>
<a href="https://example.com/doc">Docs</a>
<a href="/relative">RelLink</a>
</body></html>`;

const LONG = '<html><head><title>T</title></head><body><p>' + 'x'.repeat(12000) + '</p></body></html>';

let server: http.Server;
let port = 0;
const url = (p: string) => `http://127.0.0.1:${port}${p}`;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const p = (req.url ?? '/').split('?')[0];
    if (p === '/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    } else if (p === '/r2') {
      res.writeHead(302, { location: '/r1' });
      res.end();
    } else if (p === '/r1') {
      res.writeHead(302, { location: '/page' });
      res.end();
    } else if (p === '/missing') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found here');
    } else if (p === '/long') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(LONG);
    } else if (p === '/pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(Buffer.from('%PDF-1.4 fake'));
    } else if (p === '/gz') {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      res.end(zlib.gzipSync(Buffer.from(PAGE)));
    } else {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('isBlockedAddress', () => {
  it('blocks private/loopback/link-local/CGNAT/multicast and IPv6 equivalents', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '100.100.1.1', '192.168.0.5', '169.254.169.254', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '0.0.0.0', '172.16.5.5', '198.18.1.1', '224.0.0.5', '255.255.255.255']) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });
  it('allows public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) expect(isBlockedAddress(ip), ip).toBe(false);
  });
});

describe('checkUrl (redirect/scheme validator)', () => {
  it('rejects blocked IP literals, non-http schemes and credentials', () => {
    expect(checkUrl('http://127.0.0.1:9999/x')).toMatch(/blocked address/); // e.g. a redirect target
    expect(checkUrl('http://[::1]:8080/')).toMatch(/blocked address/);
    expect(checkUrl('ftp://example.com/x')).toMatch(/http\/https/);
    expect(checkUrl('http://u:p@example.com/')).toMatch(/credentials/);
    expect(checkUrl('not a url')).toMatch(/invalid url/);
  });
  it('allows public URLs; allowPrivate disables the address check (tests only)', () => {
    expect(checkUrl('https://8.8.8.8/')).toBeNull();
    expect(checkUrl('http://127.0.0.1:9999/x', true)).toBeNull();
  });
});

describe('htmlToText', () => {
  it('extracts structure and drops script/style/nav', () => {
    const t = htmlToText(PAGE);
    expect(t).toContain('# Hello World');
    expect(t).toContain('- Alpha');
    expect(t).toContain('Beta <tag>');
    expect(t).toContain('Docs (https://example.com/doc)');
    expect(t).toContain('RelLink');
    expect(t).not.toContain('RelLink (');
    expect(t).not.toContain('HomeLink');
    expect(t).not.toContain('SHOULD_NOT_APPEAR');
  });
});

describe('web_fetch', () => {
  const fetcher = webFetchTool({ allowPrivate: true });

  it('refuses private targets by default (SSRF)', async () => {
    const t = webFetchTool();
    const r = await t.run({ url: url('/page') }, ctx());
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/blocked/);
    const h = await t.run({ url: `http://localhost:${port}/page` }, ctx());
    expect(h.ok).toBe(false);
    expect(h.output).toMatch(/blocked/);
    expect((await t.run({ url: 'ftp://example.com/x' }, ctx())).ok).toBe(false);
    expect((await t.run({ url: 'http://u:p@example.com' }, ctx())).ok).toBe(false);
  });

  it('renders an html page with the untrusted banner', async () => {
    const r = await fetcher.run({ url: url('/page') }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toContain('UNTRUSTED WEB CONTENT');
    expect(r.output).toContain('Title: My & Page');
    expect(r.output).toContain('# Hello World');
    expect(r.output).toContain('Intro & details with spaces.');
    expect(r.output).toContain('- Beta <tag>');
    expect(r.output).toContain('Docs (https://example.com/doc)');
    expect(r.output).not.toContain('SHOULD_NOT_APPEAR');
    expect(r.output).not.toContain('HomeLink');
    expect(r.output.length).toBeLessThanOrEqual(16000);
  });

  it('follows a redirect chain', async () => {
    const r = await fetcher.run({ url: url('/r2') }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toContain(`URL: ${url('/page')}`);
    expect(r.output).toContain('Hello World');
  });

  it('reports non-2xx as HTTP <code> with a text peek', async () => {
    const r = await fetcher.run({ url: url('/missing') }, ctx());
    expect(r.ok).toBe(false);
    expect(r.output).toContain('HTTP 404');
    expect(r.output).toContain('not found here');
  });

  it('pages long content with offset/more', async () => {
    const a = await fetcher.run({ url: url('/long'), max_chars: 100 }, ctx());
    expect(a.ok).toBe(true);
    expect(a.output).toMatch(/Chars: 0-100 of 12000/);
    expect(a.output).toContain('more: call web_fetch with offset=100');
    const b = await fetcher.run({ url: url('/long'), offset: 100, max_chars: 50 }, ctx());
    expect(b.output).toMatch(/Chars: 100-150 of 12000/);
  });

  it('refuses non-textual content types', async () => {
    const r = await fetcher.run({ url: url('/pdf') }, ctx());
    expect(r.ok).toBe(false);
    expect(r.output).toContain('application/pdf');
  });

  it('decodes gzip bodies', async () => {
    const r = await fetcher.run({ url: url('/gz') }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toContain('# Hello World');
    expect(r.output).not.toContain('SHOULD_NOT_APPEAR');
  });
});

describe('parseDdgHtml', () => {
  const FIXTURE = `<div class="result">
<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone&amp;rut=abc">First &amp; Best</a>
<a class="result__snippet" href="//x"><b>Snippet</b> one &quot;quoted&quot;</a>
</div>
<div class="result">
<a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=spam.example&rut=1">Ad Title</a>
<a class="result__snippet">Ad snippet</a>
</div>
<div class="result">
<a class="result__a" href="https://example.com/two">Second Result</a>
<div class="result__snippet">Snippet two</div>
</div>`;

  it('decodes uddg links, skips ads and cleans text', () => {
    const rs = parseDdgHtml(FIXTURE);
    expect(rs.length).toBe(2);
    expect(rs[0]).toEqual({ title: 'First & Best', url: 'https://example.com/one', snippet: 'Snippet one "quoted"' });
    expect(rs[1].url).toBe('https://example.com/two');
    expect(rs[1].snippet).toBe('Snippet two');
  });
});

describe('web_search', () => {
  const saved = { ALFRED_SEARCH: process.env.ALFRED_SEARCH, SEARXNG_URL: process.env.SEARXNG_URL, BRAVE_API_KEY: process.env.BRAVE_API_KEY };
  afterEach(() => {
    for (const k of ['ALFRED_SEARCH', 'SEARXNG_URL', 'BRAVE_API_KEY'] as const) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const stub = (body: string, check?: (url: string, init: any) => void) =>
    (async (u: any, init: any) => {
      check?.(String(u), init);
      return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) } as any;
    }) as typeof fetch;

  it('ddg backend parses html results', async () => {
    delete process.env.ALFRED_SEARCH;
    let seen = '';
    const t = webSearchTool({ fetchImpl: stub('<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fx">E</a>', (u) => (seen = u)) });
    const r = await t.run({ query: 'hello world' }, ctx());
    expect(r.ok).toBe(true);
    expect(seen).toContain('html.duckduckgo.com/html/?q=hello%20world');
    expect(r.output).toContain('UNTRUSTED WEB RESULTS for "hello world" (ddg)');
  });

  it('searxng backend reads json results', async () => {
    process.env.ALFRED_SEARCH = 'searxng';
    process.env.SEARXNG_URL = 'http://x';
    let seen = '';
    const body = JSON.stringify({ results: [{ title: 'A', url: 'https://a.test/', content: 'aaa' }, { title: 'B', url: 'https://b.test/', content: 'bbb' }] });
    const t = webSearchTool({ fetchImpl: stub(body, (u) => (seen = u)) });
    const r = await t.run({ query: 'q1' }, ctx());
    expect(r.ok).toBe(true);
    expect(seen).toBe('http://x/search?q=q1&format=json');
    expect(r.output).toContain('(searxng)');
    expect(r.output).toContain('1. A');
    expect(r.output).toContain('   https://a.test/');
    expect(r.output).toContain('bbb');
  });

  it('brave backend sends the api key', async () => {
    process.env.ALFRED_SEARCH = 'brave';
    process.env.BRAVE_API_KEY = 'k123';
    const seen: { url: string; init: any }[] = [];
    const body = JSON.stringify({ web: { results: [{ title: 'T', url: 'https://t.test/', description: 'd'.repeat(400) }] } });
    const t = webSearchTool({ fetchImpl: stub(body, (u, init) => seen.push({ url: u, init })) });
    const r = await t.run({ query: 'q2', max: 3 }, ctx());
    expect(r.ok).toBe(true);
    expect(seen[0].url).toBe('https://api.search.brave.com/res/v1/web/search?q=q2&count=3');
    expect(seen[0].init.headers['X-Subscription-Token']).toBe('k123');
    expect(r.output).toContain('(brave)');
    expect(r.output).toContain('1. T');
    expect(r.output).toContain('d'.repeat(300));
    expect(r.output).not.toContain('d'.repeat(301));
  });

  it('zero results is ok', async () => {
    process.env.ALFRED_SEARCH = 'searxng';
    process.env.SEARXNG_URL = 'http://x';
    const t = webSearchTool({ fetchImpl: stub('{"results":[]}') });
    const r = await t.run({ query: 'zzz' }, ctx());
    expect(r).toEqual({ ok: true, output: 'no results for "zzz"' });
  });

  it('ddg anomaly page is an error suggesting another backend', async () => {
    delete process.env.ALFRED_SEARCH;
    const t = webSearchTool({ fetchImpl: stub('<html><body>20262138 anomaly-mode captcha</body></html>') });
    const r = await t.run({ query: 'q3' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/rate-limit/);
    expect(r.output).toMatch(/ALFRED_SEARCH=searxng/);
  });
});

describe('caps and wiring', () => {
  it('web tools carry the network cap and class deny blocks them', () => {
    expect(toolCaps('web_fetch', webFetchTool())).toContain('network');
    expect(toolCaps('web_search', webSearchTool())).toContain('network');
    expect(denies(new Set(['class:network']), 'web_search', toolCaps('web_search', webSearchTool()))).toBe(true);
    expect(denies(new Set(['class:exec']), 'web_search', toolCaps('web_search', webSearchTool()))).toBe(false);
    expect(toolCaps('web_fetch')).toContain('network'); // BUILTIN_CAPS entry
  });

  it('builtinTools registers both', () => {
    const names = builtinTools().map((t) => t.schema.name);
    expect(names).toContain('web_search');
    expect(names).toContain('web_fetch');
  });
});
