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
  async function call(method: string, body: Record<string, any>): Promise<void> {
    try {
      const res = await o.fetch(`${o.slackApi}/${method}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${o.botToken}`,
        },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(`slack ${method} failed: HTTP ${res.status}`);
      if (!data.ok) throw new Error(`slack ${method} failed: ${data.error ?? 'unknown error'}`);
    } catch (e) {
      o.onError(e instanceof Error ? e.message : String(e));
    }
  }

  return {
    postMessage(o2: { channel: string; text: string; thread_ts?: string }): Promise<void> {
      return call('chat.postMessage', o2);
    },
  };
}

export type SlackApi = ReturnType<typeof createSlackApi>;
