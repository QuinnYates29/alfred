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
  /** write-like tool names still exposed on a readOnly server */
  allowWrite?: string[];
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

interface Conn {
  ok: boolean;
  error?: string;
  client?: Client;
  tools: Tool[];
}

export class McpHub {
  private readonly conns = new Map<string, Conn>();

  constructor(private readonly cfg: McpConfig, private readonly o?: { connectTimeoutMs?: number }) {}

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
      this.conns.set(name, { ok: false, tools: [] });
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
    const readOnly = cfg.readOnly !== false;
    const allowed = new Set(cfg.allowWrite ?? []);
    const out: Tool[] = [];
    for (const t of listed) {
      const writeLike = WRITE_RE.test(t.name);
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

  private async callTool(server: string, tool: string, args: any, ctx?: ToolContext): Promise<ToolResult> {
    const conn = this.conns.get(server);
    if (!conn?.ok || !conn.client) return { ok: false, output: `mcp server ${server} is not connected` };
    if (deepOffLimits(args)) return { ok: false, output: 'Independent/ is off-limits' };
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
      return { ok: false, output: e instanceof Error ? e.message : String(e) };
    }
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

function substitute(value: any, env: Record<string, string | undefined>): any {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, v) => env[v] ?? '');
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, env));
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v, env);
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
  return substitute({ servers }, env) as McpConfig;
}
