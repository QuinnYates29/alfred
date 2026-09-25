// P9 §4 — alfred-node: the laptop daemon. Dials OUT to the Alfred server,
// serves fs/exec calls inside its roots, shows desktop notifications.
// Depends only on `ws` + Node stdlib (it runs on the Mac via `npx tsx`).
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, encode, guardRoot, outsideRoots, parseMsg, tailOut, type CallMsg, type NodeMsg } from './protocol.js';

export interface ConnectNodeOpts {
  /** ws:// or wss:// host[:port] (path is fixed: /api/nodes/connect). */
  url: string;
  token?: string;
  name: string;
  roots: string[];
  caps?: string[];
  /** Default true: reconnect with backoff 1 s → 30 s. */
  reconnect?: boolean;
  /** Default: osascript on macOS, notify-send on Linux. */
  onNotify?: (n: { level: string; title: string; body: string; url?: string }) => void;
}

export interface NodeHandle {
  close(): void;
  connected(): boolean;
}

type RunningChild = ReturnType<typeof spawn>;

function defaultNotify(n: { level: string; title: string; body: string }): void {
  try {
    if (process.platform === 'darwin') {
      const title = `${n.title}`.replace(/"/g, "'");
      const body = `${n.body}${n.url ? ` — ${n.url}` : ''}`.replace(/"/g, "'");
      const child = spawn('osascript', ['-e', `display notification "${body}" with title "Alfred" subtitle "${title}"`]);
      child.on('error', () => {});
      child.unref();
    } else {
      const urgency = n.level === 'failure' ? 'critical' : n.level === 'warn' ? 'normal' : 'low';
      const child = spawn('notify-send', ['-a', 'Alfred', '-u', urgency, n.title, `${n.body}${n.url ? ` — ${n.url}` : ''}`]);
      child.on('error', () => {});
      child.unref();
    }
  } catch {
    /* a notification must never crash the node */
  }
}

function runExec(callId: string, args: any): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
  const cmd = String(args?.cmd ?? '');
  const cwd = String(args?.cwd ?? process.cwd());
  const timeoutMs = Number(args?.timeoutMs) > 0 ? Number(args.timeoutMs) : 60_000;
  return new Promise((resolve) => {
    let child: RunningChild;
    try {
      child = spawn('bash', ['-c', cmd], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e: any) {
      resolve({ exitCode: -1, output: `spawn failed: ${e?.message ?? e}`, timedOut: false });
      return;
    }
    running.set(callId, child);
    let out = '';
    let timedOut = false;
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    child.stdout?.on('data', (b: Buffer) => {
      out += b.toString('utf8');
      if (out.length > 32_000) out = out.slice(-16_000);
    });
    child.stderr?.on('data', (b: Buffer) => {
      out += b.toString('utf8');
      if (out.length > 32_000) out = out.slice(-16_000);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, output: `${out}\nspawn error: ${e.message}`, timedOut: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: timedOut ? null : code, output: tailOut(out), timedOut });
    });
  });
}

// exec bookkeeping (call id → child, so `cancel` can kill the process group)
const running = new Map<string, RunningChild>();

function handleOp(callId: string, op: string, args: any): Promise<any> {
  switch (op) {
    case 'ping':
      return Promise.resolve({ pong: true });
    case 'readFile': {
      const p = guardRoot(rootsGlobal, args?.path);
      if (!p) return Promise.reject(new Error(outsideRoots(args?.path)));
      return Promise.resolve(readFileSync(p, 'utf8'));
    }
    case 'writeFile': {
      const p = guardRoot(rootsGlobal, args?.path);
      if (!p) return Promise.reject(new Error(outsideRoots(args?.path)));
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, String(args?.content ?? ''), 'utf8');
      return Promise.resolve(true);
    }
    case 'listDir': {
      const p = guardRoot(rootsGlobal, args?.path);
      if (!p) return Promise.reject(new Error(outsideRoots(args?.path)));
      const entries = readdirSync(p, { withFileTypes: true }).map((e) => {
        let dir = e.isDirectory();
        try {
          dir = statSync(path.join(p, e.name)).isDirectory();
        } catch {
          /* dangling symlink */
        }
        return { name: e.name, dir };
      });
      return Promise.resolve(entries);
    }
    case 'exec': {
      const cwd = guardRoot(rootsGlobal, args?.cwd ?? rootsGlobal[0]);
      if (!cwd) return Promise.reject(new Error(outsideRoots(args?.cwd)));
      return runExec(callId, { ...args, cwd });
    }
    case 'cancel': {
      const id = String(args?.callId ?? '');
      const child = running.get(id);
      if (child) {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      return Promise.resolve(true);
    }
    default:
      return Promise.reject(new Error(`unknown op: ${op}`));
  }
}

let rootsGlobal: string[] = [];

export function connectNode(o: ConnectNodeOpts): NodeHandle {
  const caps = o.caps ?? ['fs', 'shell', 'git'];
  const reconnect = o.reconnect !== false;
  const onNotify = o.onNotify ?? defaultNotify;
  rootsGlobal = o.roots.map((r) => path.resolve(r));

  let ws: WebSocket | null = null;
  let closedByUs = false;
  let backoffMs = 1_000;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let open = false;

  const target = () => {
    const u = new URL(o.url);
    u.pathname = '/api/nodes/connect';
    u.search = o.token ? `?token=${encodeURIComponent(o.token)}` : '';
    return u.toString();
  };

  const connect = () => {
    if (closedByUs) return;
    try {
      ws = new WebSocket(target(), { maxPayload: 32 * 1024 * 1024 });
    } catch {
      schedule();
      return;
    }
    ws.on('open', () => {
      open = true;
      backoffMs = 1_000;
      const hello = { type: 'hello', name: o.name, roots: rootsGlobal, caps, version: PROTOCOL_VERSION };
      ws!.send(encode(hello as NodeMsg));
    });
    ws.on('message', (data: any) => {
      const msg = parseMsg(String(data));
      if (!msg) return;
      if (msg.type === 'notify') {
        try {
          onNotify({ level: msg.level, title: msg.title, body: msg.body, ...(msg.url ? { url: msg.url } : {}) });
        } catch {
          /* never crash on a bad notification */
        }
        return;
      }
      if (msg.type !== 'call') return;
      const call = msg as CallMsg;
      Promise.resolve()
        .then(() => handleOp(call.id, call.op, call.args))
        .then(
          (value) => send({ type: 'result', id: call.id, ok: true, value }),
          (e: any) => send({ type: 'result', id: call.id, ok: false, error: e?.message ?? String(e) }),
        )
        .finally(() => {
          running.delete(call.id);
        });
    });
    const gone = () => {
      open = false;
      if (!closedByUs) schedule();
    };
    ws.on('close', gone);
    ws.on('error', () => {
      /* close follows */
    });
  };

  const send = (m: NodeMsg) => {
    if (ws && open) {
      try {
        ws.send(encode(m));
      } catch {
        /* socket gone */
      }
    }
  };

  const schedule = () => {
    if (closedByUs || !reconnect || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 30_000);
  };

  connect();

  return {
    close() {
      closedByUs = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      try {
        ws?.close();
      } catch {
        /* already gone */
      }
    },
    connected: () => open,
  };
}
