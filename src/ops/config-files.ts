// P14 §6 — edit personas / models / alfred.yaml over the API, safely.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ModuleDeps } from '../modules.js';
import { loadPersonas } from '../runtime/personas.js';
import { loadModels } from '../models.js';

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
      loadModels(tmp);
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
  if (existsSync(abs)) {
    const bak = join(backupDir, path + '.' + Date.now());
    mkdirSync(dirname(bak), { recursive: true });
    cpSync(abs, bak);
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
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
