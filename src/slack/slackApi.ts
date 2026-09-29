// P20 — tiny Slack Web API client used by the socket handlers (chat.postMessage).
export interface SlackFetch {
  (url: string, init?: any): Promise<{ ok: boolean; status: number; json(): Promise<any> }>;
}

export function createSlackApi(o: {
  botToken: string;
  slackApi: string;
  fetch: SlackFetch;
  onError(msg: string): void;
}) {
  async function call(method: string, body: Record<string, any>): Promise<Record<string, any> | null> {
    try {
      const res = await o.fetch(`${o.slackApi}/${method}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${o.botToken}`,
        },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; ts?: string };
      if (!res.ok) throw new Error(`slack ${method} failed: HTTP ${res.status}`);
      if (!data.ok) throw new Error(`slack ${method} failed: ${data.error ?? 'unknown error'}`);
      return data;
    } catch (e) {
      o.onError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  return {
    /** Resolves to the posted message's ts (null when Slack refused or did not say). */
    async postMessage(o2: { channel: string; text: string; thread_ts?: string; blocks?: any[] }): Promise<string | null> {
      const d = await call('chat.postMessage', o2);
      return typeof d?.ts === 'string' ? d.ts : null;
    },
    /** Replace a message the bot posted (the "thinking…" placeholder). Resolves true on success. */
    async update(o2: { channel: string; ts: string; text: string }): Promise<boolean> {
      return (await call('chat.update', o2)) !== null;
    },
  };
}

export type SlackApi = ReturnType<typeof createSlackApi>;
