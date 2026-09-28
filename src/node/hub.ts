// P9 §2 — the server side of the node network. NodeHub accepts alfred-node
// connections over WebSocket upgrades at /api/nodes/connect and hands out
// WorkspaceBackends. A node that misses two heartbeats is dropped.
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { NodeOfflineError, type WorkspaceBackend } from '../runtime/contract.js';
import { writeFileNoFollow } from '../pathguard.js';
import { sandboxedCommand } from '../sandbox.js';
import { encode, guardRoot, outsideRoots, parseMsg, tailOut, type CommsOp, type CommsResult, type ExecValue, type ResultMsg } from './protocol.js';

const DEFAULT_CALL_TIMEOUT_MS = 60_000;
/** P21b: Messages.app / the tel: handoff answer within seconds; don't hold a tool longer. */
const COMMS_TIMEOUT_MS = 30_000;
const PING_MS = 15_000;
const MISS_LIMIT = 2;

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class RemoteBackend implements WorkspaceBackend {
  // caps is an addition beyond the WorkspaceBackend contract (executors check it).
  constructor(
    public readonly node: string,
    public readonly caps: string[],
    private readonly hub: NodeHub,
  ) {}
  readFile(p: string): Promise<string> {
    return this.hub.rpc(this.node, 'readFile', { path: p });
  }
  writeFile(p: string, content: string): Promise<void> {
    return this.hub.rpc(this.node, 'writeFile', { path: p, content });
  }
  listDir(p: string): Promise<{ name: string; dir: boolean }[]> {
    return this.hub.rpc(this.node, 'listDir', { path: p });
  }
  exec(cmd: string, o: { cwd: string; timeoutMs: number; signal?: AbortSignal }): Promise<ExecValue> {
    return this.hub.rpc(this.node, 'exec', { cmd, cwd: o.cwd, timeoutMs: o.timeoutMs }, {
      timeoutMs: o.timeoutMs + 10_000,
      signal: o.signal,
      onCancel: (callId) => this.hub.sendRaw(this.node, { type: 'call', id: `c${Date.now().toString(36)}x`, op: 'cancel', args: { callId } }),
    });
  }
}

interface NodeConn {
  name: string;
  roots: string[];
  caps: string[];
  connectedAt: number;
  /** P10: sandbox workspace dir advertised in hello. */
  sandbox: string;
  ws: WebSocket;
  pending: Map<string, Pending>;
  misses: number;
}

export interface NodeInfo {
  name: string;
  roots: string[];
  caps: string[];
  connectedAt: number;
  /** P10: where sandbox workspaces go on this node (advertised; default <first root>/alfred-sandbox). */
  sandbox: string;
}

/**
 * LocalBackend: this machine's filesystem + bash -c, in its own process group
 * so a timeout SIGKILLs the whole tree (same semantics as an alfred-node).
 */
export class LocalBackend implements WorkspaceBackend {
  readonly node = 'local';

  async readFile(p: string): Promise<string> {
    return readFileSync(p, 'utf8');
  }
  async writeFile(p: string, content: string): Promise<void> {
    writeFileNoFollow(p, content); // callers check containment; never write through a final symlink
  }
  async listDir(p: string): Promise<{ name: string; dir: boolean }[]> {
    return readdirSync(p, { withFileTypes: true }).map((e) => {
      let dir = e.isDirectory();
      try {
        dir = statSync(path.join(p, e.name)).isDirectory();
      } catch {
        /* dangling symlink */
      }
      return { name: e.name, dir };
    });
  }
  exec(cmd: string, o: { cwd: string; timeoutMs: number; signal?: AbortSignal; workspace?: string; trusted?: boolean }): Promise<ExecValue> {
    return new Promise<ExecValue>((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        // Agent-reachable: sandboxed with the workspace (default: cwd) as the writable dir.
        // `trusted` (workspace setup) skips the sandbox; the env is scrubbed either way.
        const sc = sandboxedCommand('bash', ['-c', cmd], {
          workspace: o.workspace ?? o.cwd,
          cwd: o.cwd,
          ...(o.trusted ? { mode: 'off' as const } : {}),
        });
        child = spawn(sc.file, sc.args, { cwd: sc.cwd, env: sc.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e: any) {
        reject(e);
        return;
      }
      let out = '';
      let timedOut = false;
      let cancelled = false;
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
      }, Math.max(1, o.timeoutMs));
      const onAbort = () => {
        cancelled = true;
        kill();
      };
      if (o.signal?.aborted) onAbort();
      else o.signal?.addEventListener('abort', onAbort, { once: true });
      const collect = (b: Buffer) => {
        out += b.toString('utf8');
        if (out.length > 8000 * 4) out = out.slice(-8000);
      };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      child.on('error', (e) => {
        clearTimeout(timer);
        o.signal?.removeEventListener('abort', onAbort);
        reject(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        o.signal?.removeEventListener('abort', onAbort);
        if (cancelled) {
          reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
          return;
        }
        resolve({ exitCode: timedOut ? null : code, output: tailOut(out), timedOut });
      });
    });
  }
}

export class NodeHub {
  private readonly token?: string;
  private readonly callTimeoutMs: number;
  private readonly pingMs: number;
  private readonly missLimit: number;
  private wss: WebSocketServer | null = null;
  private servers = new Set<Server>();
  private readonly upgradeHandlers = new Map<Server, (req: any, sock: any, head: any) => void>();
  private readonly nodes = new Map<string, NodeConn>();
  private readonly listeners = new Set<(e: { node: string; online: boolean }) => void>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  private closed = false;

  constructor(o: { token?: string; callTimeoutMs?: number; pingMs?: number; missLimit?: number } = {}) {
    this.token = o.token;
    this.callTimeoutMs = o.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.pingMs = o.pingMs ?? PING_MS;
    this.missLimit = o.missLimit ?? MISS_LIMIT;
  }

  /** Handle WebSocket upgrades for /api/nodes/connect on an http.Server. */
  attach(server: Server): void {
    if (this.closed) throw new Error('NodeHub is closed');
    if (this.servers.has(server)) return;
    this.servers.add(server);
    if (!this.wss) this.wss = new WebSocketServer({ noServer: true });
    const handler = (req: any, socket: any, head: Buffer) => {
      let u: URL;
      try {
        u = new URL(req.url ?? '', 'http://localhost');
      } catch {
        socket.destroy();
        return;
      }
      if (u.pathname !== '/api/nodes/connect') return; // not ours — other upgrade handlers may run
      if (this.token && u.searchParams.get('token') !== this.token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      const wss = this.wss!;
      wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    };
    this.upgradeHandlers.set(server, handler);
    server.on('upgrade', handler);
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => this.tick(), this.pingMs);
      this.heartbeat.unref?.();
    }
  }

  list(): NodeInfo[] {
    return [...this.nodes.values()].map((c) => ({
      name: c.name,
      roots: c.roots,
      caps: c.caps,
      connectedAt: c.connectedAt,
      sandbox: c.sandbox,
    }));
  }

  info(name: string): NodeInfo | null {
    const c = this.nodes.get(name);
    return c ? { name: c.name, roots: c.roots, caps: c.caps, connectedAt: c.connectedAt, sandbox: c.sandbox } : null;
  }

  backend(node: string): WorkspaceBackend {
    if (node === 'local') return new LocalBackend();
    const c = this.nodes.get(node);
    // An absent node still gets a backend: every call on it rejects with NodeOfflineError.
    return new RemoteBackend(node, c ? [...c.caps] : [], this);
  }

  onChange(cb: (e: { node: string; online: boolean }) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Send a desktop notification to every connected node advertising cap `notify`. */
  notify(o: { level: string; title: string; body: string; url?: string }): void {
    for (const c of this.nodes.values()) {
      if (!c.caps.includes('notify')) continue;
      try {
        c.ws.send(encode({ type: 'notify', ...o }));
      } catch {
        /* socket dying */
      }
    }
  }

  /** P21b: the first connected node advertising `cap` (e.g. 'messages', 'calls'), or null. */
  withCap(cap: string): NodeInfo | null {
    for (const c of this.nodes.values()) if (c.caps.includes(cap) && c.ws.readyState === c.ws.OPEN) return this.info(c.name);
    return null;
  }

  /**
   * P21b: run a comms op (sendMessage {to, text} / placeCall {to}) on a node. Never throws:
   * an offline node, a timeout or a failed op is `{ok:false, error}`.
   */
  async call(node: string, op: CommsOp, args: Record<string, unknown>, timeoutMs = COMMS_TIMEOUT_MS): Promise<CommsResult> {
    const c = this.nodes.get(node);
    if (!c || c.ws.readyState !== c.ws.OPEN) return { ok: false, error: `node ${node} offline` };
    try {
      const v = await this.rpc(node, op, args, { timeoutMs });
      if (v && typeof v === 'object' && v.ok === true) return { ok: true };
      return { ok: false, error: typeof v?.error === 'string' && v.error ? v.error : `${op} failed on ${node}` };
    } catch (e: any) {
      // The request went out; the connection dropped or timed out before the node answered.
      // It may well have happened (a text sent) — say so, so nobody retries into a duplicate.
      return { ok: false, uncertain: true, error: `${node} got the request but disconnected before confirming (${e?.message ?? String(e)})` };
    }
  }

  /** Low-level rpc used by RemoteBackend (also used by nodeMirrorSink). */
  async rpc(node: string, op: string, args: any, o?: { timeoutMs?: number; signal?: AbortSignal; onCancel?: (callId: string) => void }): Promise<any> {
    const c = this.nodes.get(node);
    if (!c || c.ws.readyState !== c.ws.OPEN) throw new NodeOfflineError(node);
    const id = `r${++this.seq}`;
    const timeoutMs = o?.timeoutMs ?? this.callTimeoutMs;
    try {
      return await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => {
          c.pending.delete(id);
          reject(new Error(`node ${node} call ${op} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        c.pending.set(id, { resolve, reject, timer });
        c.ws.send(encode({ type: 'call', id, op, args } as any));
      });
    } catch (e) {
      if (o?.signal?.aborted && o.onCancel) o.onCancel(id);
      throw e;
    }
  }

  /** Fire-and-forget raw message to a node (no response tracked). */
  sendRaw(node: string, msg: any): void {
    const c = this.nodes.get(node);
    if (!c) return;
    try {
      c.ws.send(encode(msg));
    } catch {
      /* socket dying */
    }
  }

  close(): void {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const [server, h] of this.upgradeHandlers) {
      server.off('upgrade', h);
      this.servers.delete(server);
    }
    this.upgradeHandlers.clear();
    this.dropAll('hub closed');
    const wss = this.wss;
    this.wss = null;
    if (wss) {
      try {
        wss.close(() => {});
      } catch {
        /* already closed */
      }
    }
  }

  // ---- internals ----

  private dropAll(reason: string): void {
    for (const c of [...this.nodes.values()]) {
      this.nodes.delete(c.name);
      this.failPending(c, reason);
      try {
        c.ws.close();
      } catch {
        /* already gone */
      }
      this.emitOffline(c.name);
    }
  }

  private failPending(c: NodeConn, reason: string): void {
    for (const p of c.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new NodeOfflineError(c.name));
    }
    c.pending.clear();
  }

  private emitOffline(name: string): void {
    for (const cb of [...this.listeners]) {
      try {
        cb({ node: name, online: false });
      } catch {
        /* listener errors never break the hub */
      }
    }
  }

  private onConnection(ws: WebSocket): void {
    let helloSeen = false;
    let nodeName = '';
    ws.on('message', (data: any) => {
      const msg = parseMsg(String(data));
      if (helloSeen) {
        if (msg && msg.type === 'result') {
          const conn = this.nodes.get(nodeName);
          if (conn && conn.ws === ws) this.resolve(conn, msg as ResultMsg);
        }
        return;
      }
      if (!msg || msg.type !== 'hello' || typeof msg.name !== 'string' || !Array.isArray(msg.roots)) {
        ws.close();
        return;
      }
      helloSeen = true;
      const name = msg.name;
      nodeName = name;
      const prev = this.nodes.get(name);
      if (prev && prev.ws !== ws) {
        // second connection replaces the first
        console.log(`[nodes] ${name}: replaced by a new connection (two processes with the same --name?)`);
        this.nodes.delete(name);
        this.failPending(prev, `replaced by a new ${name} connection`);
        try {
          prev.ws.close();
        } catch {
          /* already gone */
        }
        // no offline emit: the node is still online under the same name
      }
      const conn: NodeConn = {
        name,
        roots: msg.roots.map(String),
        caps: Array.isArray(msg.caps) ? msg.caps.map(String) : [],
        connectedAt: Date.now(),
        sandbox:
          typeof (msg as any).sandbox === 'string' && (msg as any).sandbox
            ? String((msg as any).sandbox)
            : `${(msg.roots.map(String)[0] ?? '').replace(/\/+$/, '')}/alfred-sandbox`,
        ws,
        pending: new Map(),
        misses: 0,
      };
      this.nodes.set(name, conn);
      console.log(`[nodes] ${name}: connected (caps ${conn.caps.join(',')})`);
      ws.on('close', () => {
        if (this.nodes.get(name) !== conn) return;
        console.log(`[nodes] ${name}: disconnected (${((Date.now() - conn.connectedAt) / 1000).toFixed(0)} s after connecting)`);
        this.nodes.delete(name);
        this.failPending(conn, 'node disconnected');
        this.emitOffline(name);
      });
      ws.on('error', () => {
        /* close follows */
      });
      for (const cb of [...this.listeners]) {
        try {
          cb({ node: name, online: true });
        } catch {
          /* ignore */
        }
      }
    });
    ws.on('close', () => {
      if (!helloSeen) return;
    });
    ws.on('error', () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
  }

  private resolve(c: NodeConn, m: ResultMsg): void {
    const p = c.pending.get(m.id);
    if (!p) return;
    c.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.ok) p.resolve(m.value);
    else p.reject(new Error(typeof m.error === 'string' ? m.error : 'node call failed'));
  }

  private tick(): void {
    for (const c of [...this.nodes.values()]) {
      if (c.misses >= this.missLimit) {
        if (this.nodes.get(c.name) === c) {
          console.log(`[nodes] ${c.name}: dropped after ${c.misses} missed heartbeats`);
          this.nodes.delete(c.name);
          this.failPending(c, 'missed heartbeats');
          try {
            c.ws.terminate();
          } catch {
            /* ignore */
          }
          this.emitOffline(c.name);
        }
        continue;
      }
      c.misses += 1;
      const id = `p${++this.seq}`;
      const timer = setTimeout(() => {
        c.pending.delete(id);
      }, this.pingMs);
      c.pending.set(id, {
        resolve: () => {
          c.misses = 0;
        },
        reject: () => {},
        timer,
      });
      try {
        c.ws.send(encode({ type: 'call', id, op: 'ping', args: {} }));
      } catch {
        /* close event will clean up */
      }
    }
  }
}

/** Enforce roots on the node side is in client.ts; the hub trusts the node. */
export { guardRoot, outsideRoots };
