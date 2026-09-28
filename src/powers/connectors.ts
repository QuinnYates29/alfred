// P21a §3 — connectors: the MCP servers alfred uses (config/mcp.json), editable by
// Quinn (System → Connectors) and by agents (tool `connectors`, add/remove gated).
// Every change is validated, backed up, written, then the hub reconnects live.
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import express, { type Request, type Response } from 'express';
import type { Tool, ToolContext, ToolResult } from '../runtime/contract.js';
import type { ModuleDeps } from '../modules.js';
import { loadMcpConfig, placeholders, RESERVED_ENV_RE, type McpServerConfig } from '../connectors/mcp.js';
import { gated, powersRoot, sha256 } from './gate.js';

export interface ConnectorInfo {
  name: string;
  transport: 'stdio' | 'http';
  ok: boolean;
  tools: string[];
  error?: string;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
/** A program name or path: no shell syntax, no spaces (arguments go in `args`). */
const COMMAND_RE = /^[A-Za-z0-9_./@+-]{1,200}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const HEADER_KEY_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const RECONNECT_WAIT_MS = 8_000;

export function mcpPath(deps: ModuleDeps): string {
  return deps.mcpConfigPath ?? join(powersRoot(deps), 'config', 'mcp.json');
}

/** The raw file (placeholders like ${TOKEN} kept), or an empty config. */
function readRaw(path: string): { servers: Record<string, McpServerConfig>; [k: string]: any } {
  if (!existsSync(path)) return { servers: {} };
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (!raw || typeof raw !== 'object') return { servers: {} };
  if (!raw.servers || typeof raw.servers !== 'object') raw.servers = {};
  return raw;
}

function strMap(v: unknown, what: string, keyRe: RegExp): Record<string, string> | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error(`${what} must be an object of strings`);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (!keyRe.test(k)) throw new Error(`invalid ${what} key: ${k}`);
    if (typeof val !== 'string' || /[\r\n\0]/.test(val) || val.length > 4000) throw new Error(`invalid ${what} value for ${k}`);
    out[k] = val;
  }
  return Object.keys(out).length ? out : undefined;
}

/** `envAllow`: the env vars this connector's placeholders may expand (never alfred's own secrets). */
function envAllowList(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 32) throw new Error('envAllow must be a list of environment variable names');
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string' || !ENV_KEY_RE.test(x)) throw new Error(`invalid envAllow entry: ${String(x)}`);
    if (RESERVED_ENV_RE.test(x)) throw new Error(`envAllow may not name ${x}: ALFRED_*, SLACK_* and TWILIO_* are alfred's own secrets`);
    if (!out.includes(x)) out.push(x);
  }
  return out;
}

/** Placeholders must be listed in envAllow and must not name alfred's own secrets. */
function checkPlaceholders(cfg: McpServerConfig): void {
  for (const v of placeholders({ args: cfg.args, env: cfg.env, url: cfg.url, headers: cfg.headers })) {
    if (RESERVED_ENV_RE.test(v)) throw new Error(`\${${v}} is not allowed: ALFRED_*, SLACK_* and TWILIO_* are alfred's own secrets`);
    if (!(cfg.envAllow ?? []).includes(v)) throw new Error(`\${${v}} is used but not listed in envAllow`);
  }
}

/** What Quinn sees when asked to approve a connector: placeholders first, then the full config. */
export function connectorApprovalInfo(name: string, cfg: McpServerConfig): string {
  const vars = [...placeholders(cfg)];
  const head = vars.length
    ? `⚠ ENV PLACEHOLDERS — this connector will receive the values of: ${vars.map((v) => `\${${v}}`).join(', ')}`
    : 'no env placeholders';
  return `${head}\nconnector ${name}: ${JSON.stringify(cfg, null, 2)}`.slice(0, 4000);
}

/** Validates an add request. Returns the name and the server config to store. Throws Error(reason). */
export function validateConnector(input: any): { name: string; cfg: McpServerConfig } {
  const name = typeof input?.name === 'string' ? input.name : '';
  if (!NAME_RE.test(name)) throw new Error('name must be 1-40 letters, digits, _ or - (starting with a letter or digit)');
  const hasCmd = input.command !== undefined && input.command !== null && input.command !== '';
  const hasUrl = input.url !== undefined && input.url !== null && input.url !== '';
  if (hasCmd === hasUrl) throw new Error('give exactly one of command (stdio) or url (http)');
  if (hasCmd) {
    const command = String(input.command);
    if (!COMMAND_RE.test(command)) throw new Error('command must be a program name or path without spaces or shell syntax; put arguments in args');
    const args = input.args ?? [];
    if (!Array.isArray(args) || args.length > 64 || !args.every((x: unknown) => typeof x === 'string' && x.length <= 2000 && !x.includes('\0'))) {
      throw new Error('args must be an array of strings');
    }
    if (input.headers) throw new Error('headers are for http connectors');
    const env = strMap(input.env, 'env', ENV_KEY_RE);
    const cfg: McpServerConfig = { command, ...(args.length ? { args: args.map(String) } : {}), ...(env ? { env } : {}), envAllow: envAllowList(input.envAllow) };
    checkPlaceholders(cfg);
    return { name, cfg };
  }
  let url: URL;
  try {
    url = new URL(String(input.url));
  } catch {
    throw new Error(`invalid url: ${input.url}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('url must be http(s)');
  if (input.args || input.env) throw new Error('args and env are for stdio connectors');
  const headers = strMap(input.headers, 'headers', HEADER_KEY_RE);
  // Keep the placeholders as typed (URL parsing percent-encodes `${`/`}`).
  const raw = String(input.url);
  const cfg: McpServerConfig = { url: placeholders(raw).size ? raw : url.toString(), ...(headers ? { headers } : {}), envAllow: envAllowList(input.envAllow) };
  if (/[\s"'<>\\^`{|}]/.test(raw.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, ''))) throw new Error(`invalid url: ${raw}`);
  checkPlaceholders(cfg);
  return { name, cfg };
}

export class Connectors {
  /** The file's servers as last loaded into the hub (so a reload can drop removed ones). */
  private lastFile: Record<string, McpServerConfig> | undefined;

  constructor(private deps: ModuleDeps) {}

  list(): ConnectorInfo[] {
    const hub = this.deps.hub;
    const live = new Map((hub?.status() ?? []).map((s) => [s.name, s]));
    // The file's servers (even ones the hub hasn't picked up) + the hub's (incl. plugin-registered).
    const servers: Record<string, McpServerConfig> = { ...loadMcpConfig(mcpPath(this.deps), this.deps.env).servers, ...(hub?.servers() ?? {}) };
    return Object.entries(servers).map(([name, cfg]) => {
      const s = live.get(name);
      const info: ConnectorInfo = { name, transport: cfg.command ? 'stdio' : 'http', ok: s?.ok ?? false, tools: s?.tools ?? [] };
      if (cfg.disabled) info.error = 'disabled';
      else if (s?.error) info.error = s.error;
      return info;
    });
  }

  /** Write the file (backup first, atomic rename), then reload the hub. */
  private async write(mutate: (servers: Record<string, McpServerConfig>) => void): Promise<void> {
    const path = mcpPath(this.deps);
    const raw = readRaw(path);
    const before = loadMcpConfig(path, this.deps.env).servers;
    mutate(raw.servers);
    if (existsSync(path)) {
      const backupDir = (this.deps.extra?.backupDir as string | undefined) ?? join(powersRoot(this.deps), '.alfred-backup');
      const bak = join(backupDir, 'config', `mcp.json.${Date.now()}`);
      mkdirSync(dirname(bak), { recursive: true });
      cpSync(path, bak);
    }
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
    renameSync(tmp, path);
    await this.reload(before);
  }

  /** Hub servers = (hub's servers − the old file's) + the new file's: plugin-registered servers survive. */
  async reload(before?: Record<string, McpServerConfig>): Promise<void> {
    const hub = this.deps.hub;
    if (!hub) return;
    const current = hub.servers();
    for (const name of Object.keys(before ?? this.lastFile ?? {})) delete current[name];
    const file = loadMcpConfig(mcpPath(this.deps), this.deps.env).servers;
    this.lastFile = file;
    await this.settle(hub.reconfigure({ ...current, ...file }));
  }

  /** A dead server can take the connect timeout; don't hold a request/tool that long. */
  private async settle(p: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([p, new Promise<void>((r) => (timer = setTimeout(r, RECONNECT_WAIT_MS)))]);
    clearTimeout(timer);
    const { hub, registry } = this.deps;
    for (const t of hub?.tools() ?? []) if (!registry.get(t.schema.name)) registry.register(t);
  }

  async add(input: any): Promise<ConnectorInfo> {
    const { name, cfg } = validateConnector(input);
    await this.write((servers) => {
      servers[name] = cfg;
    });
    return this.list().find((c) => c.name === name)!;
  }

  async remove(name: string): Promise<boolean> {
    if (!NAME_RE.test(name)) return false;
    const raw = readRaw(mcpPath(this.deps));
    if (!raw.servers[name]) return false;
    await this.write((servers) => {
      delete servers[name];
    });
    return true;
  }

  /** Drop the connection and dial again. */
  async reconnect(name: string): Promise<ConnectorInfo | null> {
    const hub = this.deps.hub;
    if (!hub) return null;
    const servers = hub.servers();
    if (!servers[name]) return null;
    const without = { ...servers };
    delete without[name];
    await hub.reconfigure(without);
    await this.settle(hub.reconfigure(servers));
    return this.list().find((c) => c.name === name) ?? null;
  }
}

function fmt(c: ConnectorInfo): string {
  const tools = c.tools.length ? `${c.tools.length} tools (${c.tools.slice(0, 8).join(', ')}${c.tools.length > 8 ? ', …' : ''})` : 'no tools';
  return `${c.name} [${c.transport}] ${c.ok ? 'connected' : 'down'} — ${tools}${c.error ? `; error: ${c.error.slice(0, 200)}` : ''}`;
}

export function connectorsRouter(deps: ModuleDeps, conns: Connectors): express.Router {
  const r = express.Router();
  const logOp = (action: string, target: string, ok: boolean, by?: unknown) => {
    try {
      deps.store.appendEvent('', null, 'ops', { action, target, ok, by: by ?? 'api' });
    } catch {
      /* never break the response */
    }
  };
  const h =
    (fn: (req: Request, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response): void => {
      fn(req, res).catch((e: any) => {
        if (!res.headersSent) res.status(500).json({ error: e?.message ?? String(e) });
      });
    };

  r.get('/connectors', h(async (_req, res) => res.json(conns.list())));

  r.post(
    '/connectors',
    h(async (req, res) => {
      const body = req.body ?? {};
      if (body.confirm !== true) return res.status(400).json({ error: 'confirm required' });
      try {
        validateConnector(body);
      } catch (e: any) {
        return res.status(400).json({ error: e?.message ?? String(e) });
      }
      const out = await conns.add(body);
      logOp('connector.add', out.name, true, body.by);
      res.status(201).json(out);
    }),
  );

  r.delete(
    '/connectors/:name',
    h(async (req, res) => {
      const body = req.body ?? {};
      if (body.confirm !== true) return res.status(400).json({ error: 'confirm required' });
      const name = String(req.params.name);
      if (!(await conns.remove(name))) return res.status(404).json({ error: `no such connector in config/mcp.json: ${name}` });
      logOp('connector.remove', name, true, body.by);
      res.json({ ok: true });
    }),
  );

  r.post(
    '/connectors/:name/reconnect',
    h(async (req, res) => {
      const out = await conns.reconnect(String(req.params.name));
      if (!out) return res.status(404).json({ error: `no such connector: ${req.params.name}` });
      res.json(out);
    }),
  );

  return r;
}

export function connectorsTool(deps: ModuleDeps, conns: Connectors): Tool {
  return {
    kind: 'exec',
    schema: {
      name: 'connectors',
      description:
        'MCP connectors (config/mcp.json). op list|add|remove|reconnect. add: name + command/args/env (stdio) or url/headers (http). add/remove need approval.',
      parameters: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['list', 'add', 'remove', 'reconnect'] },
          name: { type: 'string' },
          command: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
          env: { type: 'object' },
          envAllow: { type: 'array', items: { type: 'string' }, description: 'env vars ${VAR} placeholders may use' },
          url: { type: 'string' },
          headers: { type: 'object' },
        },
        required: ['op'],
      },
    },
    async run(args: any, ctx: ToolContext): Promise<ToolResult> {
      const a = args ?? {};
      const op = String(a.op ?? '');
      const gate = { deps, tool: ctx };
      try {
        if (op === 'list') {
          const list = conns.list();
          return { ok: true, output: list.length ? list.map(fmt).join('\n') : 'no connectors configured' };
        }
        if (op === 'reconnect') {
          const c = await conns.reconnect(String(a.name ?? ''));
          return c ? { ok: c.ok, output: fmt(c) } : { ok: false, output: `no such connector: ${a.name ?? ''}` };
        }
        if (op === 'add') {
          let v;
          try {
            v = validateConnector(a);
          } catch (e: any) {
            return { ok: false, output: e?.message ?? String(e) };
          }
          const shown = JSON.stringify(v.cfg);
          return await gated(
            gate,
            'connectors',
            `connector:${v.name}:add`,
            async () => {
              const c = await conns.add(a);
              return { ok: true, output: `saved ${v.name} to config/mcp.json; ${fmt(c)}` };
            },
            // The approval is bound to this exact config: the same name with another command is re-asked.
            { bind: sha256(shown), info: connectorApprovalInfo(v.name, v.cfg) },
          );
        }
        if (op === 'remove') {
          const name = String(a.name ?? '');
          if (!NAME_RE.test(name)) return { ok: false, output: `invalid name: ${name}` };
          return await gated(gate, 'connectors', `connector:${name}:remove`, async () =>
            (await conns.remove(name)) ? { ok: true, output: `removed ${name}` } : { ok: false, output: `no such connector in config/mcp.json: ${name}` },
          );
        }
        return { ok: false, output: `unknown op: ${op}` };
      } catch (e: any) {
        return { ok: false, output: `error: ${e?.message ?? String(e)}` };
      }
    },
  };
}
