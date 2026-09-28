'use strict';
// P18 — tiny API client: request() with the Bearer token, stream() = SSE over fetch with reconnect.

/** Parse complete SSE frames out of `buf`; returns { events: [{id, data}], rest }. */
function parseSSE(buf) {
  const events = [];
  const norm = buf.replace(/\r\n/g, '\n');
  const parts = norm.split('\n\n');
  const rest = parts.pop() ?? '';
  for (const frame of parts) {
    let id = null;
    const data = [];
    for (const line of frame.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const i = line.indexOf(':');
      const field = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
      if (field === 'id') id = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length) events.push({ id, data: data.join('\n') });
  }
  return { events, rest };
}

/** Backoff for the n-th consecutive failure: 1, 2, 4, … capped at 30 s. */
function backoffMs(n) {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, n));
}

/**
 * @param {() => {url: string, token: string}} conf  read on every call, so Save takes effect immediately
 * @param {{fetch?: typeof fetch, timeoutMs?: number}} [o]
 */
function createApi(conf, o = {}) {
  const doFetch = o.fetch ?? globalThis.fetch;
  const timeoutMs = o.timeoutMs ?? 15_000;

  const headers = (c, json) => ({
    ...(c.token ? { authorization: `Bearer ${c.token}` } : {}),
    ...(json ? { 'content-type': 'application/json' } : {}),
  });

  /** JSON request (ro: {conf?, timeoutMs?}); throws Error(<server error or HTTP status>) with .status on failure. */
  async function request(method, p, body, ro = {}) {
    const c = ro.conf ?? conf();
    if (!c.url) throw new Error('no server URL configured');
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ro.timeoutMs ?? timeoutMs);
    try {
      const res = await doFetch(c.url + p, {
        method,
        headers: headers(c, body !== undefined),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* not JSON */
      }
      if (!res.ok) {
        const err = new Error((json && json.error) || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return json;
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('request timed out');
      throw e;
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Keep one SSE connection to `pathFor(lastId)`; onEvent(parsedJson, id) per frame. Reconnects with
   * backoff 1 → 30 s; a stream silent for `idleMs` (server pings every 10 s) is treated as dead.
   * onStatus(bool) reports connected/disconnected. Returns { close() }.
   */
  function stream(pathFor, onEvent, opts = {}) {
    const idleMs = opts.idleMs ?? 35_000;
    let closed = false;
    let ctl = null;
    let failures = 0;
    let lastId = opts.since ?? null;
    let timer = null;

    const status = (up) => {
      try {
        opts.onStatus?.(up);
      } catch {
        /* ignore */
      }
    };

    async function once() {
      const c = conf();
      ctl = new AbortController();
      let idle = null;
      const kick = () => {
        clearTimeout(idle);
        idle = setTimeout(() => ctl.abort(), idleMs);
      };
      try {
        if (lastId === null && opts.start) lastId = await opts.start();
        const res = await doFetch(c.url + pathFor(lastId), { headers: { ...headers(c, false), accept: 'text/event-stream' }, signal: ctl.signal });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        failures = 0;
        status(true);
        kick();
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          kick();
          buf += dec.decode(value, { stream: true });
          const { events, rest } = parseSSE(buf);
          buf = rest;
          for (const ev of events) {
            if (ev.id !== null && ev.id !== '') lastId = Number(ev.id);
            let parsed;
            try {
              parsed = JSON.parse(ev.data);
            } catch {
              continue;
            }
            try {
              onEvent(parsed, lastId);
            } catch {
              /* a bad handler must not kill the stream */
            }
          }
        }
      } finally {
        clearTimeout(idle);
      }
    }

    async function loop() {
      while (!closed) {
        try {
          await once();
        } catch {
          /* fall through to backoff */
        }
        if (closed) break;
        status(false);
        const wait = backoffMs(failures++);
        await new Promise((r) => {
          timer = setTimeout(r, wait);
        });
      }
    }
    void loop();

    return {
      close() {
        closed = true;
        clearTimeout(timer);
        ctl?.abort();
      },
      lastId: () => lastId,
    };
  }

  return { request, stream };
}

module.exports = { createApi, parseSSE, backoffMs };
