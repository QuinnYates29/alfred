// Minimal API client: token handling + JSON fetch against /api.
const TOKEN_KEY = 'alfred.token';

export function captureToken() {
  try {
    const t = new URLSearchParams(location.search).get('token');
    if (t) localStorage.setItem(TOKEN_KEY, t);
  } catch {
    /* private mode */
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
