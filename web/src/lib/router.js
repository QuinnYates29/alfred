// Hash routing. Routes: #/ (home), #/inbox, #/board[/<KEY>], #/goals, #/goal/<id>[/<tab>], #/chat[/<threadId>],
// #/automations, #/system[/<tab>], #/deck. Legacy aliases: #/approvals → inbox, #/personas|models|nodes → system tabs.
import { useEffect, useState } from 'react';

export function parseHash(hash = location.hash) {
  const raw = (hash || '#/').replace(/^#/, '') || '/';
  const [pathPart, queryPart = ''] = raw.split('?');
  const path = pathPart.startsWith('/') ? pathPart : '/' + pathPart;
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const query = Object.fromEntries(new URLSearchParams(queryPart));
  return { path, parts, query };
}

export function useRoute() {
  const [r, setR] = useState(() => parseHash());
  useEffect(() => {
    const on = () => setR(parseHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return r;
}

/** go('/goal/abc') or go('/board', { q: 'x' }) */
export function go(path, query) {
  const q = query && Object.keys(query).length ? '?' + new URLSearchParams(query).toString() : '';
  location.hash = path + q;
}

export const href = (path) => '#' + path;

/** Update query params of the current route without adding history noise. */
export function setQuery(patch) {
  const { path, query } = parseHash();
  const next = { ...query, ...patch };
  for (const k of Object.keys(next)) if (next[k] === '' || next[k] == null) delete next[k];
  const q = Object.keys(next).length ? '?' + new URLSearchParams(next).toString() : '';
  history.replaceState(null, '', '#' + path + q);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}
