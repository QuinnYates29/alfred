// Minimal API client: token handling + JSON fetch against /api.
const TOKEN_KEY = 'alfred.token';

export function captureToken(loc = globalThis.location, hist = globalThis.history, store = globalThis.localStorage) {
  let params;
  try {
    params = new URLSearchParams(loc.search);
  } catch {
    return;
  }
  const t = params.get('token');
  if (t == null) return;
  try {
    if (t) store.setItem(TOKEN_KEY, t);
  } catch {
    /* private mode */
  }
  // Strip ?token= from the address bar (history, bookmarks, Referer), keeping the hash route.
  params.delete('token');
  const q = params.toString();
  try {
    hist.replaceState(hist.state, '', loc.pathname + (q ? `?${q}` : '') + (loc.hash || ''));
  } catch {
    /* sandboxed */
  }
}

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function authQuery(base) {
  const t = getToken();
  if (!t) return base;
  return base + (base.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(t);
}

/**
 * URL for an EventSource on `path`: trades the bearer token for a single-use 60 s ticket
 * (so the token never sits in a URL); falls back to ?token= if the server has no ticket route.
 */
export async function sseUrl(path) {
  const t = getToken();
  if (!t) return path;
  try {
    const { ticket } = await api('/api/v1/events/ticket', { method: 'POST', body: {} });
    if (ticket) return path + (path.includes('?') ? '&' : '?') + 'ticket=' + encodeURIComponent(ticket);
  } catch (e) {
    if (e && e.status === 401) throw e;
  }
  return authQuery(path);
}

export async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body !== undefined && !headers['content-type']) headers['content-type'] = 'application/json';
  const t = getToken();
  if (t) headers.authorization = 'Bearer ' + t;
  const res = await fetch(path, { ...opts, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) throw Object.assign(new Error((data && data.error) || `${res.status} ${res.statusText}`), { status: res.status, data });
  return data;
}

export const post = (path, body) => api(path, { method: 'POST', body: body ?? {} });
export const del = (path) => api(path, { method: 'DELETE' });
