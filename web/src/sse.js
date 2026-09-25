import { useEffect, useRef, useState } from 'react';
import { authQuery } from './api.js';

/**
 * One EventSource('/api/events?since=<lastId>') for the whole app.
 * Reconnects with backoff; `onEvent` gets every parsed event row.
 * Returns connection state: 'connecting' | 'open' | 'down'.
 */
export function useEvents(onEvent) {
  const [state, setState] = useState('connecting');
  const cbRef = useRef(onEvent);
  cbRef.current = onEvent;

  useEffect(() => {
    let es = null;
    let lastId = 0;
    let delay = 500;
    let timer = null;
    let closed = false;

    const connect = () => {
      if (closed) return;
      setState('connecting');
      es = new EventSource(authQuery(`/api/events?since=${lastId}`));
      es.onopen = () => {
        delay = 500;
        setState('open');
      };
      es.onmessage = (m) => {
        try {
          const ev = JSON.parse(m.data);
          if (typeof ev.id === 'number' && ev.id > lastId) lastId = ev.id;
          cbRef.current?.(ev);
        } catch {
          /* keepalive or malformed frame */
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
      if (timer) clearTimeout(timer);
      es?.close();
    };
  }, []);

  return state;
}
