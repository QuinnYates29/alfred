// Models page permissions matrix: persona `tools:` lists and per-model `deny:` lists.
// Every write goes through the config editor path (validate → backup → write → reload).
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { isMap, isSeq, parseDocument, type Document } from 'yaml';
import type { ModuleDeps } from '../modules.js';
import { modelsConfigPath } from '../models.js';
import { CONFIG_PATH_RE, putConfigFile, validateConfigContent } from './config-files.js';

export interface PermissionsBody {
  /** persona name → its complete new `tools:` list */
  personas?: Record<string, unknown>;
  /** model name → its complete new `deny:` list ([] removes the key) */
  models?: Record<string, unknown>;
}

const bad = (msg: string) => Object.assign(new Error(msg), { status: 400 });

function toolList(what: string, v: unknown): string[] {
  if (!Array.isArray(v) || v.some((t) => typeof t !== 'string' || !t)) throw bad(`${what}: must be a list of tool names`);
  return [...new Set(v as string[])];
}

function flowSeq(doc: Document, items: string[]) {
  const node = doc.createNode(items);
  (node as any).flow = true;
  return node;
}

/** repo-relative path of the models config the registry uses. */
function modelsRelPath(deps: ModuleDeps): string {
  const abs = deps.models?.configPath?.() ?? modelsConfigPath(join(deps.repoRoot, 'config'));
  const rel = relative(deps.repoRoot, abs);
  if (!CONFIG_PATH_RE.test(rel)) throw bad(`models config ${abs} is outside config/; edit it by hand`);
  return rel;
}

/** Builds every changed file's new content, validates all of them, then writes them. */
export function applyPermissions(deps: ModuleDeps, backupDir: string, body: PermissionsBody) {
  const edits: { path: string; content: string }[] = [];

  for (const [name, v] of Object.entries(body.personas ?? {})) {
    const tools = toolList(`persona ${name}`, v);
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw bad(`bad persona name: ${name}`);
    const file = ['yaml', 'yml'].map((ext) => `personas/${name}.${ext}`).find((p) => existsSync(join(deps.personasDir, p.slice(9))));
    if (!file) throw bad(`persona ${name} has no file in the personas dir`);
    const doc = parseDocument(readFileSync(join(deps.personasDir, file.slice(9)), 'utf8'));
    doc.set('tools', flowSeq(doc, tools));
    edits.push({ path: file, content: String(doc) });
  }

  const models = Object.entries(body.models ?? {});
  if (models.length) {
    const path = modelsRelPath(deps);
    const doc = parseDocument(readFileSync(join(deps.repoRoot, path), 'utf8'));
    const seq = doc.get('models');
    if (!isSeq(seq)) throw bad(`${path}: no models list`);
    for (const [name, v] of models) {
      const deny = toolList(`model ${name} deny`, v);
      const item = seq.items.find((it) => isMap(it) && it.get('name') === name);
      if (!isMap(item)) throw bad(`unknown model: ${name}`);
      if (deny.length) item.set('deny', flowSeq(doc, deny));
      else item.delete('deny');
    }
    edits.push({ path, content: String(doc) });
  }

  if (!edits.length) throw bad('nothing to change');
  for (const e of edits) {
    try {
      validateConfigContent(deps, e.path, e.content);
    } catch (err: any) {
      throw bad(`${e.path}: ${err?.message ?? String(err)}`);
    }
  }
  const reloaded = new Set<string>();
  const warnings: string[] = [];
  for (const e of edits) {
    const out = putConfigFile(deps, backupDir, e.path, e.content);
    out.reloaded.forEach((r) => reloaded.add(r));
    warnings.push(...out.warnings);
  }
  return { ok: true as const, written: edits.map((e) => e.path), reloaded: [...reloaded], warnings };
}
