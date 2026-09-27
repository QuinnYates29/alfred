// One SSE stream for the whole app + a data hook that refetches when relevant events arrive.
//
//   const { data, error, loading, reload } = useResource('/api/items?board=ALF', { on: ['item_'] });
//   useLive(ev => ev.kind === 'chat_message' && ev.data.threadId === id, ev => ...);
//
// `on` matches event kinds by prefix ('item_' matches item_created/item_moved/…), or is a predicate (ev) => boolean.
// Refetches are debounced (150 ms) so a burst of events costs one request.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, authQuery } from '../api.js';

const LiveCtx = createContext(null);

export function LiveProvider({ children }) {
  const subs = useRef(new Set());
  const [state, setState] = useState('connecting');
  useEffect(() => {
    let es = null;
    let lastId = null;
    let delay = 500;
    let timer = null;
    let closed = false;
    const connect = async () => {
      if (closed) return;
      if (lastId == null) {
        try {
          lastId = (await api('/api/events/last')).id ?? 0;
        } catch {
          lastId = 0;
        }
      }
      setState('connecting');
      es = new EventSource(authQuery(`/api/events?since=${lastId}`));
      es.onopen = () => {
        delay = 500;
        setState('open');
      };
      es.onmessage = (m) => {
        let ev;
        try {
          ev = JSON.parse(m.data);
        } catch {
          return;
        }
        if (typeof ev.id === 'number' && ev.id > lastId) lastId = ev.id;
        for (const cb of subs.current) {
          try {
            cb(ev);
          } catch (e) {
            console.error(e);
          }
        }
      };
      es.onerror = () => {
        es.close();
        if (closed) return;
        setState('down');
        timer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 10_000);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      es?.close();
    };
  }, []);
  const subscribe = useCallback((cb) => {
    subs.current.add(cb);
    return () => subs.current.delete(cb);
  }, []);
  return <LiveCtx.Provider value={{ state, subscribe }}>{children}</LiveCtx.Provider>;
}

export const useLiveState = () => useContext(LiveCtx)?.state ?? 'connecting';

export function matcher(on) {
  if (!on) return () => false;
  if (typeof on === 'function') return on;
  const list = Array.isArray(on) ? on : [on];
  return (ev) => list.some((k) => ev.kind === k || (k.endsWith('_') && ev.kind.startsWith(k)) || k === '*');
}

/** Call `cb(ev)` for every live event that matches `on`. */
export function useLive(on, cb) {
  const ctx = useContext(LiveCtx);
  const cbRef = useRef(cb);
  cbRef.current = cb;
  const onRef = useRef(on);
  onRef.current = on;
  useEffect(() => {
    if (!ctx) return;
    return ctx.subscribe((ev) => {
      if (matcher(onRef.current)(ev)) cbRef.current(ev);
    });
  }, [ctx]);
}

/**
 * GET `path` (null = skip), refetch when a matching event arrives or every `interval` ms.
 * Keeps showing the previous data while refetching.
 */
export function useResource(path, { on, interval, deps = [] } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(path != null);
  const seq = useRef(0);
  const debounce = useRef(null);

  const reload = useCallback(() => {
    if (path == null) return Promise.resolve();
    const my = ++seq.current;
    return api(path)
      .then((d) => {
        if (my !== seq.current) return;
        setData(d);
        setError(null);
      })
      .catch((e) => my === seq.current && setError(e))
      .finally(() => my === seq.current && setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);

  useEffect(() => {
    setLoading(path != null);
    reload();
  }, [reload]);

  useEffect(() => {
    if (!interval || path == null) return;
    const t = setInterval(reload, interval);
    return () => clearInterval(t);
  }, [reload, interval, path]);

  useLive(on, () => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(reload, 150);
  });

  return { data, error, loading, reload, setData };
}
