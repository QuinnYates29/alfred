// P11 — one config file: config/alfred.yaml, with config/alfred.local.yaml
// merged over it, then env vars (ALFRED_*) over that. Tokens are env-only.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';

export interface AlfredConfigFile {
  server: { port: number; host: string };
  paths: { db: string; work: string; gitHub: string; mirror: string };
  models: string;
  mcp: string;
  plugins: { enabled?: string[]; [name: string]: any };
}

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

function isPlainObj(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep merge: `over` wins; plain objects merge recursively, everything else replaces. */
export function deepMerge<T>(base: T, over: any): T {
  if (!isPlainObj(base) || !isPlainObj(over)) return (over === undefined ? base : over);
  const out: Record<string, any> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

function readYaml(file: string): Record<string, any> {
  if (!existsSync(file)) return {};
  const doc = parse(readFileSync(file, 'utf8'));
  return isPlainObj(doc) ? doc : {};
}

const DEFAULTS: AlfredConfigFile = {
  server: { port: 8790, host: '127.0.0.1' },
  paths: {
    db: '~/.alfred/alfred.db',
    work: '~/.alfred/work',
    gitHub: '~/.alfred/git',
    mirror: 'local:~/vaults/alfred',
  },
  models: 'config/models.yaml',
  mcp: 'config/mcp.json',
  plugins: { enabled: ['builtin-executors', 'builtin-sinks', 'builtin-deck'] },
};

/**
 * repoRoot may point at the repo root (config/alfred.yaml) or directly at a
 * directory containing alfred.yaml (tests pass a temp dir).
 */
export function loadConfig(
  repoRoot: string,
  env: Record<string, string | undefined> = {},
): AlfredConfigFile {
  const dir = existsSync(join(repoRoot, 'config', 'alfred.yaml'))
    ? join(repoRoot, 'config')
    : repoRoot;

  let c = deepMerge(DEFAULTS, readYaml(join(dir, 'alfred.yaml')));
  c = deepMerge(c, readYaml(join(dir, 'alfred.local.yaml')));

  if (env.ALFRED_PORT) c.server.port = Number(env.ALFRED_PORT);
  if (env.ALFRED_HOST) c.server.host = env.ALFRED_HOST;
  if (env.ALFRED_DB) c.paths.db = env.ALFRED_DB;
  if (env.ALFRED_WORK_ROOT) c.paths.work = env.ALFRED_WORK_ROOT;
  if (env.ALFRED_MIRROR_DIR) c.paths.mirror = env.ALFRED_MIRROR_DIR;
  if (env.ALFRED_PLUGINS) {
    c.plugins.enabled = env.ALFRED_PLUGINS.split(',').map((s) => s.trim()).filter(Boolean);
  }

  // Expand ~ everywhere (mirror keeps its `local:` prefix; expand each part).
  c.paths = {
    db: expandHome(c.paths.db),
    work: expandHome(c.paths.work),
    gitHub: expandHome(c.paths.gitHub),
    mirror: String(c.paths.mirror)
      .split(':')
      .map((p, i) => (i === 0 && !p.startsWith('~') ? p : expandHome(p)))
      .join(':'),
  };
  if (!c.paths.db.startsWith('/')) c.paths.db = join(repoRoot, c.paths.db);
  if (!c.paths.work.startsWith('/')) c.paths.work = join(repoRoot, c.paths.work);
  if (!c.models.startsWith('/')) c.models = join(repoRoot, c.models);
  if (!c.mcp.startsWith('/')) c.mcp = join(repoRoot, c.mcp);
  return c;
}
