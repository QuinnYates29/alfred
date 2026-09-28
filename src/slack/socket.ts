// P20 — Socket Mode connection runner: apps.connections.open → ws, ack every
// envelope, reconnect with backoff on disconnect/close, stop() ends the loop.
export interface WSLike {
  on(ev: string, cb: (...args: any[]) => void): void;
  send(data: string): void;
  close(): void;
  readyState: number;
}

export interface SocketOpts {
  appToken: string;
  slackApi: string;
  fetch: (url: string, init?: any) => Promise<any>;
  WebSocket: new (url: string) => WSLike;
  backoffMs: number[];
  onEnvelope(env: { envelope_id?: string; type?: string; payload?: any }): { payload?: any } | undefined;
  onError(msg: string): void;
}

export interface SocketCtl {
  stop(): void;
  connected(): boolean;
}

export function connectSlack(o: SocketOpts): SocketCtl {
  let stopped = false;
  let ws: WSLike | null = null;
  let attempt = 0;
  let wake: (() => void) | null = null;

  function sleep(ms: number): Promise<void> {
    return new Promise<void>((res) => {
      const t = setTimeout(res, ms);
      wake = () => {
        clearTimeout(t);
        res();
      };
    });
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      try {
        const res = await o.fetch(`${o.slackApi}/apps.connections.open`, {
          method: 'POST',
          headers: { authorization: `Bearer ${o.appToken}`, 'content-type': 'application/json' },
        });
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; url?: string; error?: string };
        if (!data.ok || !data.url) {
          throw new Error(`apps.connections.open failed: ${data.error ?? 'no url'}`);
        }
        const closed = await new Promise<void>((resolve) => {
          const sock = new o.WebSocket(data.url!);
          ws = sock;
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            if (ws === sock) ws = null;
            resolve();
          };
          sock.on('open', () => {
            attempt = 0;
          });
          sock.on('message', (raw: any) => {
            let env: any;
            try {
              env = JSON.parse(String(raw));
            } catch {
              return;
            }
            if (!env || typeof env !== 'object') return;
            if (env.type === 'disconnect') {
              try {
                sock.close();
              } catch {
                /* already gone */
              }
              return;
            }
            let ackPayload: any;
            try {
              ackPayload = o.onEnvelope(env)?.payload;
            } catch (e) {
              o.onError(`slack envelope: ${e instanceof Error ? e.message : String(e)}`);
            }
            try {
              if (env.envelope_id && sock.readyState === 1) {
                sock.send(JSON.stringify(ackPayload ? { envelope_id: env.envelope_id, payload: ackPayload } : { envelope_id: env.envelope_id }));
              }
            } catch {
              /* ack lost */
            }
          });
          sock.on('close', finish);
          sock.on('error', (e: any) => o.onError(`slack socket: ${e?.message ?? String(e)}`));
        });
        void closed;
      } catch (e) {
        if (stopped) break;
        o.onError(e instanceof Error ? e.message : String(e));
      }
      if (stopped) break;
      const list = o.backoffMs.length ? o.backoffMs : [1000];
      await sleep(list[Math.min(attempt, list.length - 1)]);
      attempt++;
    }
  }
  void loop();

  return {
    stop() {
      stopped = true;
      if (wake) wake();
      const s = ws;
      ws = null;
      try {
        s?.close();
      } catch {
        /* already closed */
      }
    },
    connected() {
      return ws !== null && ws.readyState === 1;
    },
  };
}
