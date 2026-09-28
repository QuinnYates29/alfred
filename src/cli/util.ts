// P19 — shared CLI plumbing: argv parsing, connection resolution, HTTP, confirmations.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parse as parseYaml } from 'yaml';

export interface Parsed {
  rest: string[];
  flags: Map<string, string[]>; // repeatable (--check)
  bools: Set<string>;
}

function push(m: Map<string, string[]>, k: string, v: string) {
  const arr = m.get(k) ?? [];
  arr.push(v);
  m.set(k, arr);
}

export function parseArgs(argv: string[]): Parsed {
  const rest: string[] = [];
  const flags = new Map<string, string[]>();
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      bools.add('help');
    } else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        push(flags, a.slice(2, eq), a.slice(eq + 1));
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        push(flags, a.slice(2), argv[++i]);
      } else {
        bools.add(a.slice(2));
      }
    } else {
      rest.push(a);
    }
  }
  return { rest, flags, bools };
}

export const flag = (p: Parsed, k: string) => p.flags.get(k)?.[0];
export const flags = (p: Parsed, k: string) => p.flags.get(k) ?? [];
export const enc = encodeURIComponent;

export function parseCheck(s: string): { name: string; cmd: string } {
  const eq = s.indexOf('=');
  if (eq <= 0) throw new Error(`--check wants "name=cmd", got "${s}"`);
  return { name: s.slice(0, eq).trim(), cmd: s.slice(eq + 1).trim() };
}

/** Same `---`-fenced frontmatter shape the markdown automations use. */
export function splitFrontmatter(text: string): { fm: Record<string, any>; body: string } {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        const fm = parseYaml(lines.slice(1, i).join('\n')) as Record<string, any>;
        return { fm: fm ?? {}, body: lines.slice(i + 1).join('\n') };
      }
    }
  }
  return { fm: {}, body: text };
}

// ---- connection ----

export function configPath(): string {
  return process.env.ALFRED_CLI_CONFIG ?? join(homedir(), '.config', 'alfred', 'cli.json');
}

/** env wins; then the config file; then localhost:8790. Never throws. */
export function resolveConn(): { url: string; token: string } {
  let cfg: any = {};
  try {
    cfg = JSON.parse(readFileSync(configPath(), 'utf8'));
  } catch {
    /* no/invalid config file — defaults */
  }
  const url = (process.env.ALFRED_URL
    ?? (typeof cfg.url === 'string' && cfg.url ? cfg.url : '')
    ?? 'http://127.0.0.1:8790').replace(/\/+$/, '');
  const token = process.env.ALFRED_TOKEN ?? (typeof cfg.token === 'string' ? cfg.token : '') ?? '';
  return { url, token };
}

export function writeConfig(url: string, token: string): string {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ url, token }));
  chmodSync(path, 0o600);
  return path;
}

export class Api {
  constructor(readonly url: string, readonly token: string) {}

  /** One API call. Throws a one-line Error on transport/HTTP failure. */
  async req(method: string, path: string, body?: unknown, rawText = false): Promise<any> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await fetch(this.url + '/api/v1' + path, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new Error(`cannot reach alfred at ${this.url} (is \`alfred serve\` running?)`);
    }
    const text = await res.text();
    if (rawText) {
      if (!res.ok) throw new Error(`${res.status} ${text}`);
      return text;
    }
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) throw new Error(typeof data?.error === 'string' ? data.error : `${res.status} ${text}`);
    return data;
  }

  get(path: string) {
    return this.req('GET', path);
  }
}

// ---- output helpers ----

/** --json prints the raw API JSON; otherwise render the text form. */
export function print(p: Parsed, data: unknown, render: () => void): void {
  if (p.bools.has('json')) console.log(JSON.stringify(data, null, 2));
  else render();
}

/**
 * Mutating-op gate. `--yes` skips it; a terminal asks y/N; a non-terminal refuses.
 * Returns false only when the user answers no (caller exits 0 quietly).
 */
export async function confirm(action: string, p: Parsed): Promise<boolean> {
  if (p.bools.has('yes')) return true;
  if (!process.stdin.isTTY) {
    throw new Error(`refusing to ${action} without --yes (not a terminal)`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = (await rl.question(`Really ${action}? [y/N] `)).trim().toLowerCase();
    return ans === 'y' || ans === 'yes';
  } finally {
    rl.close();
  }
}

export const firstLine = (s: unknown): string => String(s ?? '').split('\n')[0] ?? '';
