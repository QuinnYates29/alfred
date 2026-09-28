// P20 — Slack module (Socket Mode): approval buttons land here as `interactive`
// envelopes, /alfred slash commands and DMs/mentions run the chat engine.
import type { AlfredModule, ModuleDeps } from '../modules.js';
import { connectSlack, type SocketCtl, type WSLike } from './socket.js';
import { handleInteractive, handleSlash, handleEvent, type HandlerCtx } from './handlers.js';
import { createSlackApi } from './slackApi.js';
import { openThreadMap, type ChatLike } from './threadMap.js';
import { slackRouter } from './routes.js';

const DEFAULT_BACKOFF = [1000, 5000, 30000];

function chatOf(deps: ModuleDeps): ChatLike | undefined {
  return (deps.modules.chat as any)?.chat;
}
function boardOf(deps: ModuleDeps): any {
  return (deps.modules.board as any)?.board;
}

export function createSlackModule(deps: ModuleDeps): AlfredModule {
  let lastError: string | null = null;
  let ctl: SocketCtl | null = null;
  let stopped = false;
  let chain = Promise.resolve();

  const doFetch: typeof fetch = deps.extra.fetch ?? ((...a: any[]) => (fetch as any)(...a));
  const setError = (msg: string) => {
    lastError = msg;
  };
  const postUrl = async (url: string, body: any): Promise<void> => {
    try {
      await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      setError(`slack response_url: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const enqueue = (fn: () => Promise<void>) => {
    chain = chain.then(fn).catch((e) => {
      setError(String(e?.message ?? e));
    });
  };
  const lanes = new Map<string, Promise<void>>();
  const enqueueFor = (key: string, fn: () => Promise<void>) => {
    const next = (lanes.get(key) ?? Promise.resolve()).then(fn).catch((e) => setError(String(e?.message ?? e)));
    lanes.set(key, next);
    void next.finally(() => { if (lanes.get(key) === next) lanes.delete(key); });
  };
  const slackApi = deps.env.SLACK_BOT_TOKEN
    ? createSlackApi({
        botToken: deps.env.SLACK_BOT_TOKEN,
        slackApi: deps.extra.slackApi ?? 'https://slack.com/api',
        fetch: doFetch,
        onError: setError,
      })
    : undefined;
  const threads = openThreadMap(deps.store, () => chatOf(deps));

  const ctx: HandlerCtx = {
    store: deps.store,
    getBoard: () => boardOf(deps),
    getChat: () => chatOf(deps),
    threads,
    slackApi,
    postUrl,
    enqueue,
    enqueueFor,
    setError,
    allowedUsers: new Set((deps.env.SLACK_ALLOWED_USERS ?? '').split(',').map((u) => u.trim()).filter(Boolean)),
  };

  const onEnvelope = (env: { envelope_id?: string; type?: string; payload?: any }) => {
    const { type, payload } = env;
    // types only — never content — so "is Slack reaching alfred?" is answerable from the journal
    console.log(`[slack] ${type}${payload?.event?.type ? `/${payload.event.type}` : payload?.type ? `/${payload.type}` : ''}`);
    if (type === 'interactive') {
      handleInteractive(ctx, payload ?? {});
      return undefined;
    }
    if (type === 'slash_commands') {
      if (payload?.command && payload.command !== '/alfred') return undefined;
      return { payload: handleSlash(ctx, payload ?? {}) };
    }
    if (type === 'events_api') {
      handleEvent(ctx, payload?.event ?? {});
      return undefined;
    }
    return undefined;
  };

  const configured = Boolean(deps.env.SLACK_BOT_TOKEN && deps.env.SLACK_APP_TOKEN);

  return {
    name: 'slack',
    router: slackRouter(() => ({
      configured,
      connected: ctl ? ctl.connected() : false,
      lastError,
    })),
    async start() {
      if (!configured || ctl || stopped) return;
      const WebSocket: new (url: string) => WSLike =
        deps.extra.WebSocket ??
        ((await import('ws')).WebSocket as unknown as new (url: string) => WSLike);
      if (stopped) return; // stop() ran while we were importing
      ctl = connectSlack({
        appToken: deps.env.SLACK_APP_TOKEN!,
        slackApi: deps.extra.slackApi ?? 'https://slack.com/api',
        fetch: doFetch,
        WebSocket,
        backoffMs: deps.extra.slackBackoffMs ?? DEFAULT_BACKOFF,
        onEnvelope,
        onError: setError,
      });
    },
    stop() {
      stopped = true;
      ctl?.stop();
      ctl = null;
    },
  };
}
