// P11 built-in plugin: Mission Deck supervision. If the deck already answers
// on its port, use it; otherwise spawn `node dist/index.js` and restart with
// backoff while Alfred runs. No config → no supervision.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AlfredPlugin } from '../../plugins.js';

export interface DeckState {
  url?: string | null;
}

export interface BuiltinDeckDeps {
  deckState: DeckState;
}

async function reachable(port: number): Promise<boolean> {
  for (const path of ['/api/health', '/']) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        signal: AbortSignal.timeout(1500),
      });
      if (res.status < 500) return true;
    } catch {
      /* keep trying */
    }
  }
  return false;
}

export function builtinDeckPlugin(deps: BuiltinDeckDeps): AlfredPlugin {
  let child: ChildProcessWithoutNullStreams | null = null;
  let stopping = false;
  let backoffMs = 1000;

  return {
    name: 'builtin-deck',
    version: '1.0.0',
    async setup(ctx) {
      const dir = ctx.config?.dir as string | undefined;
      const port = Number(ctx.config?.port ?? 8787);
      if (!dir) return;
      deps.deckState.url = `http://127.0.0.1:${port}`;
      if (await reachable(port)) {
        ctx.log(`deck already running on ${port}`);
        return;
      }
      stopping = false;
      const launch = () => {
        if (stopping) return;
        child = spawn('node', ['dist/index.js'], {
          cwd: String(dir),
          env: { ...process.env, PORT: String(port) },
          stdio: 'ignore',
        });
        child.on('exit', () => {
          if (stopping) return;
          ctx.log(`deck exited; restarting in ${backoffMs}ms`);
          const t = setTimeout(launch, backoffMs);
          if (typeof t.unref === 'function') t.unref();
          backoffMs = Math.min(backoffMs * 2, 30_000);
        });
      };
      launch();
    },
    async teardown() {
      stopping = true;
      child?.kill();
      child = null;
    },
  };
}
