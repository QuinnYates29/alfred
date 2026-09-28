// P14 §6 — edit personas / models / alfred.yaml over the API, safely.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ModuleDeps } from '../modules.js';
import { loadPersonas } from '../runtime/personas.js';
import { loadModels } from '../models.js';
import { backupPrivate, writePrivateFile } from '../secure-fs.js';

export const CONFIG_PATH_RE = /^(personas\/[A-Za-z0-9_.-]+\.ya?ml|config\/[A-Za-z0-9_.-]+\.(ya?ml|json))$/;

export type ConfigKind = 'persona' | 'models' | 'alfred' | 'mcp' | 'other';

export function configKind(path: string): ConfigKind {
  if (path.startsWith('personas/')) return 'persona';
  const base = path.slice('config/'.length);
  if (/^models.*\.ya?ml$/.test(base)) return 'models';
  if (/^alfred.*\.ya?ml$/.test(base)) return 'alfred';
  if (/^mcp.*\.json$/.test(base)) return 'mcp';
  return 'other';
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** repo-relative path → absolute, or null if it doesn't match the allow-list. */
export function resolveConfigPath(deps: ModuleDeps, path: string): string | null {
  if (!CONFIG_PATH_RE.test(path)) return null;
  return path.startsWith('personas/')
    ? join(deps.personasDir, baseName(path))
    : join(deps.repoRoot, path);
}

export interface ConfigFileInfo {
  path: string;
  kind: ConfigKind;
  size: number;
  mtime: number;
}

export function listConfigFiles(deps: ModuleDeps): ConfigFileInfo[] {
  const out: ConfigFileInfo[] = [];
  const push = (rel: string) => {
    try {
      const st = statSync(resolveConfigPath(deps, rel)!);
      out.push({ path: rel, kind: configKind(rel), size: st.size, mtime: Math.floor(st.mtimeMs) });
    } catch {
      /* vanished mid-list */
    }
  };
  try {
    for (const f of readdirSync(deps.personasDir)) {
      if (/^[A-Za-z0-9_.-]+\.ya?ml$/.test(f)) push(`personas/${f}`);
    }
  } catch {
    /* no personas dir */
  }
  const cfgDir = join(deps.repoRoot, 'config');
  try {
    for (const f of readdirSync(cfgDir)) {
      if (CONFIG_PATH_RE.test(`config/${f}`)) push(`config/${f}`);
    }
  } catch {
    /* no config dir */
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Throws Error(message) when the content is not loadable. Writes nothing. */
export function validateConfigContent(deps: ModuleDeps, path: string, content: string): void {
  const kind = configKind(path);
  const isJson = path.endsWith('.json');
  if (isJson) {
    JSON.parse(content); // throws SyntaxError
  } else {
    parseYaml(content); // throws YAMLException
  }
  if (kind === 'persona') {
    // Full load of a copy of the personas dir: budget + unknown-tool checks.
    const tmp = join(tmpdir(), `alfred-personas-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      cpSync(deps.personasDir, tmp, { recursive: true });
      writeFileSync(join(tmp, baseName(path)), content);
      loadPersonas(tmp, deps.registry);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  } else if (kind === 'models') {
    const tmp = join(tmpdir(), `alfred-models-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`);
    try {
      writeFileSync(tmp, content);
      loadModels(tmp, { knownTools: deps.registry.all().map((t) => t.schema.name) });
    } finally {
      rmSync(tmp, { force: true });
    }
  }
}

export interface PutConfigResult {
  ok: true;
  path: string;
  mtime: number;
  reloaded: ('personas' | 'models')[];
  warnings: string[];
}

export function putConfigFile(
  deps: ModuleDeps,
  backupDir: string,
  path: string,
  content: string,
  mtime?: number,
): PutConfigResult {
  const abs = resolveConfigPath(deps, path);
  if (!abs) throw Object.assign(new Error(`invalid path: ${path}`), { status: 400 });
  if (mtime !== undefined && mtime !== null && existsSync(abs)) {
    if (Math.floor(statSync(abs).mtimeMs) !== mtime) {
      throw Object.assign(new Error('file changed since you read it (mtime mismatch)'), { status: 409 });
    }
  }
  // Validate BEFORE touching the file.
  try {
    validateConfigContent(deps, path, content);
  } catch (e: any) {
    throw Object.assign(new Error(e?.message ?? String(e)), { status: 400, isValidation: true });
  }
  if (containsRedaction(content)) {
    throw Object.assign(
      new Error('content still has «redacted» placeholders: this file holds literal secrets — edit it on disk or move them to ${ENV} references'),
      { status: 400, isValidation: true },
    );
  }
  // Config may hold secrets (mcp.json headers, *.local.yaml): owner-only file and backups.
  if (existsSync(abs)) backupPrivate(abs, backupDir, path + '.' + Date.now());
  mkdirSync(dirname(abs), { recursive: true });
  writePrivateFile(abs, content);
  const reloaded: ('personas' | 'models')[] = [];
  const warnings: string[] = [];
  const kind = configKind(path);
  if (kind === 'persona') {
    const errs = deps.reloadPersonas?.() ?? [];
    reloaded.push('personas');
    warnings.push(...errs);
  } else if (kind === 'models') {
    try {
      deps.models?.reload();
      reloaded.push('models');
    } catch (e: any) {
      warnings.push(`models reload failed: ${e?.message ?? String(e)}`);
    }
  }
  return { ok: true, path, mtime: Math.floor(statSync(abs).mtimeMs), reloaded, warnings };
}

// ---- secrets in served config ----
// Tokens are env-only by design (config.ts), but a hand-edited mcp.json / *.local.yaml may still
// carry literal secrets. GET /ops/config/file masks them; a PUT that still has a mask is refused
// (it would overwrite the real secret with the placeholder).
export const REDACTED = '«redacted»';
const SECRET_KEY_RE = /(token|secret|password|passwd|api[_-]?key|authorization|private[_-]?key)$/i;
// `key: value` (YAML, optionally a list item) or `"key": value` (JSON).
const KV_RE = /^(\s*(?:-\s+)?(["']?)([A-Za-z0-9_.-]+)\2\s*:\s*)(.*?)(\s*,?\s*)$/;
const JSON_PAIR_RE = /("([A-Za-z0-9_.-]+)"\s*:\s*)"((?:[^"\\]|\\.)*)"/g;
const BEARER_RE = /\b(Bearer|Basic)\s+(?!\$\{)[A-Za-z0-9._~+/=-]{8,}/g;

function isHarmlessValue(v: string): boolean {
  const bare = v.replace(/^["']|["']$/g, '').trim();
  return (
    bare === '' ||
    bare.includes('${') || // an env reference, resolved at load time
    bare.startsWith('#') ||
    /^[[{|>]/.test(bare) ||
    /^(true|false|null|~|-?\d+(\.\d+)?)$/i.test(bare)
  );
}

export function containsRedaction(content: string): boolean {
  return content.includes('«redacted');
}

/** Mask literal secret values; `redactEnv` also masks values of secrets known from the env. */
export function redactConfigContent(
  content: string,
  redactEnv: (s: string) => string = (s) => s,
): { content: string; redacted: boolean } {
  let redacted = false;
  const lines = content.split('\n').map((line) => {
    let out = line;
    const m = KV_RE.exec(line);
    if (m && SECRET_KEY_RE.test(m[3]!) && !isHarmlessValue(m[4]!)) {
      const v = m[4]!;
      const q = v.startsWith('"') ? '"' : v.startsWith("'") ? "'" : '';
      out = `${m[1]}${q}${REDACTED}${q}${m[5]}`;
    }
    // JSON pairs anywhere on the line (inline objects: `{ "API_KEY": "…" }`).
    out = out.replace(JSON_PAIR_RE, (all, pre: string, key: string, val: string) =>
      SECRET_KEY_RE.test(key) && !isHarmlessValue(val) ? `${pre}"${REDACTED}"` : all);
    out = out.replace(BEARER_RE, (_all, scheme) => `${scheme} ${REDACTED}`);
    return out;
  });
  let text = lines.join('\n');
  if (text !== content) redacted = true;
  const envText = redactEnv(text);
  if (envText !== text) redacted = true;
  text = envText;
  return { content: text, redacted };
}
