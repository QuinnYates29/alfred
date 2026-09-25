// P11 built-in plugin: alert channels (desktop / slack / markdown / node).
// The env contract from P3 is kept: ALFRED_NOTIFY_DESKTOP=0 drops the desktop
// sink; slack only registers when configured. Disable the whole plugin in
// config to silence everything except other plugins' sinks.
import type { AlfredPlugin } from '../../plugins.js';
import type { Sink, Notice } from '../../types.js';
import type { Store } from '../../store.js';
import { sinksFromEnv } from '../../notify/sinks.js';

export interface BuiltinSinksDeps {
  env: () => Record<string, string | undefined>;
  store: Store;
  mirrorDir: () => string;
}

function nodeSink(url: string): Sink {
  return {
    name: 'node',
    async send(n: Notice): Promise<void> {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(n),
      });
      if (!res.ok) throw new Error(`node sink failed: HTTP ${res.status}`);
    },
  };
}

export function builtinSinksPlugin(deps: BuiltinSinksDeps): AlfredPlugin {
  return {
    name: 'builtin-sinks',
    version: '1.0.0',
    setup(ctx) {
      const env = deps.env();
      let { sinks, warnings } = sinksFromEnv(env, deps.store, deps.mirrorDir());
      if (env.ALFRED_NOTIFY_DESKTOP === '0') sinks = sinks.filter((s) => s.name !== 'desktop');
      for (const w of warnings) ctx.log(w);
      const nodeUrl = ctx.config?.nodeUrl ?? env.ALFRED_NODE_URL;
      if (nodeUrl) sinks.push(nodeSink(String(nodeUrl)));
      for (const s of sinks) ctx.registerSink(s);
    },
  };
}
