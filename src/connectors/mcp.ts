// P3 MCP hub: connect to MCP servers (stdio or streamable HTTP), expose their
// tools as runtime Tools. A dead server never takes the hub down.
import { existsSync, readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool, ToolContext, ToolResult } from '../runtime/contract.js';

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  /** default true. Hides write-like tools. */
  readOnly?: boolean;
  /** Connected, but NOT exposed as agent tools or through `connectors`: only alfred's own modules
   *  call it (hub.callInternal), with their own policy — e.g. the Obsidian vault behind the `vault` tool. */
  internal?: boolean;
  /** write-like tool names still exposed on a readOnly server */
  allowWrite?: string[];
  /** Environment variables this server's `${VAR}` placeholders may expand. When present, ONLY these
   *  expand (connectors added through alfred always carry it). Absent = a hand-written legacy entry:
   *  any variable except the reserved ones. ALFRED_*, SLACK_*, TWILIO_* never expand. */
  envAllow?: string[];
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

const WRITE_RE = /(write|create|update|delete|append|move|rename|patch|put|remove|edit)/i;
const OFF_LIMITS_RE = /(^|\/)Independent(\/|$)/i;
const OUTPUT_CAP = 8000;

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

/** True if any string anywhere in the value matches the off-limits pattern. */
function deepOffLimits(value: unknown): boolean {
  if (typeof value === 'string') return OFF_LIMITS_RE.test(value);
  if (Array.isArray(value)) return value.some(deepOffLimits);
  if (value && typeof value === 'object') return Object.values(value).some(deepOffLimits);
  return false;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} after ${ms}ms`)), ms);
    if (typeof (timer as any).unref === 'function') (timer as any).unref();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Transport/session-level failures (not tool errors): worth one reconnect + replay. */
export const SESSION_LOST_RE = /session|\b40[04]\b|not connected|ECONNRESET|ECONNREFUSED|EPIPE|socket|fetch failed|terminated|closed|aborted by the server|other side/i;

interface Conn {
  ok: boolean;
  error?: string;
  client?: Client;
  tools: Tool[];
}

export class McpHub {
  private readonly conns = new Map<string, Conn>();

  constructor(private cfg: McpConfig, private readonly o?: { connectTimeoutMs?: number }) {}

  private get timeoutMs(): number {
    return this.o?.connectTimeoutMs ?? 15_000;
  }

  /** P5 dashboard: one row per configured node — state, tool count, error. */
  list() {
    return [...this.conns.entries()].map(([name, c]) => ({
      id: name,
      name,
      connected: c.ok,
      tools: c.tools.length,
      ...(c.error ? { error: c.error } : {}),
    }));
  }

  /** Never rejects. Retries only servers that are not currently connected. */
  async connectAll(): Promise<void> {
    for (const [name, cfg] of Object.entries(this.cfg.servers ?? {})) {
      if (cfg.disabled) continue;
      if (this.conns.get(name)?.ok) continue;
      await this.connectOne(name, cfg);
    }
  }

  /** Connect ONE server now (dropping any old client). Concurrent callers share one attempt. Never rejects. */
  async reconnect(name: string): Promise<boolean> {
    const cfg = this.cfg.servers?.[name];
    if (!cfg || cfg.disabled) return false;
    let p = this.reconnecting.get(name);
    if (!p) {
      p = (async () => {
        const old = this.conns.get(name);
        try {
          await old?.client?.close();
        } catch {
          /* already gone */
        }
        await this.connectOne(name, cfg);
        return !!this.conns.get(name)?.ok;
      })().finally(() => this.reconnecting.delete(name));
      this.reconnecting.set(name, p);
    }
    return p;
  }

  private readonly reconnecting = new Map<string, Promise<boolean>>();

  private async connectOne(name: string, cfg: McpServerConfig): Promise<void> {
    {
      // keep the previous tools listed while reconnecting; mark not-ok until the handshake lands
      this.conns.set(name, { ok: false, tools: this.conns.get(name)?.tools ?? [] });
      let client: Client | undefined;
      try {
        client = new Client({ name: 'alfred', version: '0.1.0' });
        const transport = cfg.command
          ? new StdioClientTransport({
              command: cfg.command,
              args: cfg.args ?? [],
              env: cfg.env ? { ...getDefaultEnvironment(), ...cfg.env } : undefined,
            })
          : new StreamableHTTPClientTransport(new URL(cfg.url ?? ''), {
              requestInit: { headers: cfg.headers },
            });
        try {
          await withTimeout(client.connect(transport), this.timeoutMs, `connect to ${name} timed out`);
          const listed: any = await withTimeout(client.listTools(), this.timeoutMs, `listTools on ${name} timed out`);
          this.conns.set(name, { ok: true, client, tools: this.buildTools(name, cfg, listed.tools ?? []) });
        } catch (e) {
          try {
            await client.close();
          } catch {
            /* ignore */
          }
          throw e;
        }
      } catch (e) {
        this.conns.set(name, { ok: false, error: e instanceof Error ? e.message : String(e), tools: [] });
      }
    }
  }

  private buildTools(server: string, cfg: McpServerConfig, listed: any[]): Tool[] {
    if (cfg.internal) return [];
    const readOnly = cfg.readOnly !== false;
    const allowed = new Set(cfg.allowWrite ?? []);
    const out: Tool[] = [];
    for (const t of listed) {
      // A multi-action tool (`vault` with action: list|read|delete|move…) is write-like by what it can
      // DO, not by its name — otherwise a readOnly server leaks delete/move to agents.
      const actions: unknown = t.inputSchema?.properties?.action?.enum ?? t.inputSchema?.properties?.operation?.enum;
      const writeLike = WRITE_RE.test(t.name) || (Array.isArray(actions) && actions.some((a) => typeof a === 'string' && WRITE_RE.test(a)));
      if (readOnly && writeLike && !allowed.has(t.name)) continue;
      out.push({
        schema: {
          name: `${sanitize(server)}_${sanitize(t.name)}`,
          description: t.description ?? `${server}: ${t.name}`,
          parameters: t.inputSchema ?? { type: 'object', properties: {} },
        },
        kind: writeLike ? 'write' : 'read',
        run: (args: any, ctx: ToolContext) => this.callTool(server, t.name, args, ctx),
      });
    }
    return out;
  }

  private async callTool(server: string, tool: string, args: any, ctx?: ToolContext, isRetry = false): Promise<ToolResult> {
    if (deepOffLimits(args)) return { ok: false, output: 'Independent/ is off-limits' };
    let conn = this.conns.get(server);
    // Not connected (e.g. the server was down at the last 5-minute retry): try once now instead of failing.
    if ((!conn?.ok || !conn.client) && !isRetry && (await this.reconnect(server))) conn = this.conns.get(server);
    if (!conn?.ok || !conn.client) return { ok: false, output: `mcp server ${server} is not connected${conn?.error ? ` (${conn.error})` : ''}` };
    try {
      const res: any = await conn.client.callTool(
        { name: tool, arguments: args ?? {} },
        undefined,
        { signal: ctx?.signal } as any,
      );
      const text = (res.content ?? [])
        .filter((c: any) => c?.type === 'text')
        .map((c: any) => c.text ?? '')
        .join('\n');
      return { ok: !res.isError, output: text.slice(0, OUTPUT_CAP) };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // The session died under us (server restart / idle GC → 404 "session not found", reset socket, closed
      // transport): reconnect once and replay, so a long-lived hub doesn't stay "connected" to a dead session.
      if (!isRetry && !ctx?.signal?.aborted && SESSION_LOST_RE.test(msg) && (await this.reconnect(server))) {
        return this.callTool(server, tool, args, ctx, true);
      }
      return { ok: false, output: msg };
    }
  }

  /** Is this server connected right now? */
  connected(server: string): boolean {
    return !!this.conns.get(server)?.ok;
  }

  /** Call a tool of an `internal` server from alfred's own code (the caller enforces its policy). */
  async callInternal(server: string, tool: string, args: any, signal?: AbortSignal): Promise<ToolResult> {
    return this.callTool(server, tool, args, signal ? ({ signal } as ToolContext) : undefined);
  }

  status(): { name: string; ok: boolean; tools: string[]; error?: string }[] {
    const out: { name: string; ok: boolean; tools: string[]; error?: string }[] = [];
    for (const [name, cfg] of Object.entries(this.cfg.servers ?? {})) {
      if (cfg.disabled) continue;
      const conn = this.conns.get(name);
      const entry: { name: string; ok: boolean; tools: string[]; error?: string } = {
        name,
        ok: conn?.ok ?? false,
        tools: conn?.tools.map((t) => t.schema.name) ?? [],
      };
      if (!entry.ok && conn?.error) entry.error = conn.error;
      out.push(entry);
    }
    return out;
  }

  tools(): Tool[] {
    const out: Tool[] = [];
    for (const conn of this.conns.values()) if (conn.ok) out.push(...conn.tools);
    return out;
  }

  /** P21: swap the server set live — closes removed/changed servers, connects new ones. Never rejects. */
  async reconfigure(servers: Record<string, McpServerConfig>): Promise<void> {
    const prev = this.cfg.servers ?? {};
    for (const [name, conn] of [...this.conns.entries()]) {
      const next = servers[name];
      if (!next || JSON.stringify(next) !== JSON.stringify(prev[name]) || next.disabled) {
        try {
          await conn.client?.close();
        } catch {
          /* never throw */
        }
        this.conns.delete(name);
      }
    }
    this.cfg = { ...this.cfg, servers };
    await this.connectAll();
  }

  /** P21: the configured servers (after env substitution). */
  servers(): Record<string, McpServerConfig> {
    return { ...(this.cfg.servers ?? {}) };
  }

  async close(): Promise<void> {
    for (const conn of this.conns.values()) {
      try {
        await conn.client?.close();
      } catch {
        /* never throw */
      }
    }
    this.conns.clear();
  }
}

/** alfred's own secrets: never expanded into a connector's url/args/headers/env. */
export const RESERVED_ENV_RE = /^(ALFRED_|SLACK_|TWILIO_)/;
export const PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Every `${VAR}` named anywhere in a value. */
export function placeholders(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === 'string') for (const m of value.matchAll(PLACEHOLDER_RE)) out.add(m[1]!);
  else if (Array.isArray(value)) value.forEach((v) => placeholders(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => placeholders(v, out));
  return out;
}

/** May this server expand `${name}`? */
export function envAllowed(cfg: { envAllow?: unknown }, name: string): boolean {
  if (RESERVED_ENV_RE.test(name)) return false;
  if (Array.isArray(cfg.envAllow)) return cfg.envAllow.includes(name);
  return true;
}

function substitute(value: any, env: Record<string, string | undefined>, allow: (v: string) => boolean): any {
  if (typeof value === 'string') {
    return value.replace(PLACEHOLDER_RE, (_, v) => (allow(v) ? env[v] ?? '' : ''));
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, env, allow));
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v, env, allow);
    return out;
  }
  return value;
}

export function loadMcpConfig(path: string, env: Record<string, string | undefined> = {}): McpConfig {
  const empty: McpConfig = { servers: {} };
  if (!existsSync(path)) return empty;
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return empty;
  }
  const servers = raw && typeof raw.servers === 'object' && raw.servers !== null ? raw.servers : {};
  const out: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(servers as Record<string, any>)) {
    const c = cfg && typeof cfg === 'object' ? cfg : {};
    out[name] = substitute(c, env, (v) => envAllowed(c, v));
  }
  return { servers: out };
}
