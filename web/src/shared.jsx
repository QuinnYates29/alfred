import { useEffect, useState } from 'react';
import { api } from './api.js';

/** Current hash route as a path string, e.g. '/goal/abc'. Reacts to hashchange. */
export function useHashRoute() {
  const read = () => (location.hash || '#/').replace(/^#/, '') || '/';
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export const go = (path) => {
  location.hash = path;
};

/** GET `path` now and again whenever `refreshKey` changes. */
export function useFetch(path, refreshKey, opts = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (path === null) return;
    let live = true;
    api(path)
      .then((d) => {
        if (!live) return;
        setData(d);
        setError(null);
      })
      .catch((e) => live && setError(e))
      .finally(() => live && !opts.keep && undefined);
    return () => {
      live = false;
    };
  }, [path, refreshKey]);
  return { data, error, setError };
}

export function Chip({ status }) {
  return <span className={`chip ${status}`}>{status}</span>;
}

export function elapsed(startMs, endMs) {
  const s = Math.max(0, Math.floor(((endMs ?? Date.now()) - startMs) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export const fmtTime = (ts) => new Date(ts).toLocaleTimeString();

/** statuses that mean a goal needs attention. Summaries are flat: goal fields + counts. */
export function goalNeedsAttention(summary) {
  if (!summary) return false;
  if (summary.status === 'failed') return true;
  const c = summary.counts || {};
  return (c.failed || 0) + (c.blocked || 0) + (c.needs_claude || 0) > 0;
}
