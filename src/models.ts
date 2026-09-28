// P7 — swappable models: config/models.yaml maps names/roles to OpenAI-compatible
// endpoints; the registry resolves refs per call and limits concurrency per endpoint.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import type { LLM } from './runtime/contract.js';
import { openaiLLM } from './runtime/openai.js';
import { denyEntryError } from './runtime/caps.js';

export interface ModelSpec {
  name: string;
  baseUrl: string;
  model: string;
  apiKeyEnv?: string;
  /** Concurrent calls allowed to THIS endpoint (shared by every model on the same baseUrl). Default 3. */
  slots?: number;
  contextWindow?: number;
  maxTokens?: number;
  temperature?: number;
  /** Tools no agent may use while running on this model (only ever restricts; persona tools AND not-denied).
   *  An entry is a tool name or `class:<cap>` (runtime/caps.ts), e.g. `class:exec`. */
  deny?: string[];
}

export interface ModelsConfig {
  models: ModelSpec[];
  roles: Record<string, string>;
}

export class ModelConfigError extends Error {}

export const DEFAULT_SLOTS = 3;
export const DEFAULT_CONTEXT_WINDOW = 65536;
/** Control tools a task needs to end; a model may not deny them. */
export const UNDENIABLE_TOOLS = ['finish', 'give_up'];

/** config/models.local.yaml wins if present (gitignored). */
export function modelsConfigPath(dir = 'config'): string {
  const local = path.join(dir, 'models.local.yaml');
  return existsSync(local) ? local : path.join(dir, 'models.yaml');
}

function fail(msg: string): never {
  throw new ModelConfigError(msg);
}

/**
 * Reads + validates a models config. Violations → ModelConfigError.
 * knownTools: when given, every `deny` entry must name one (the config editor passes the tool registry).
 */
export function loadModels(filePath: string, o?: { knownTools?: Iterable<string> }): ModelsConfig {
  const known = o?.knownTools ? new Set(o.knownTools) : null;
  let doc: unknown;
  try {
    doc = parse(readFileSync(filePath, 'utf8'));
  } catch (e: any) {
    return fail(`models config ${filePath}: ${e?.message ?? String(e)}`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) fail(`models config ${filePath}: not a mapping`);
  const raw = doc as { models?: unknown; roles?: unknown };
  if (!Array.isArray(raw.models) || raw.models.length === 0) fail(`models config ${filePath}: missing "models" list`);

  const models: ModelSpec[] = [];
  const names = new Set<string>();
  raw.models.forEach((m: any, i: number) => {
    if (!m || typeof m !== 'object') fail(`model #${i}: not a mapping`);
    for (const k of ['name', 'baseUrl', 'model'] as const) {
      if (typeof m[k] !== 'string' || !m[k]) fail(`model #${i}: missing "${k}"`);
    }
    if (names.has(m.name)) fail(`duplicate model name "${m.name}"`);
    names.add(m.name);
    const spec: ModelSpec = { name: m.name, baseUrl: m.baseUrl.replace(/\/+$/, ''), model: m.model };
    if (m.apiKeyEnv !== undefined && m.apiKeyEnv !== null) {
      if (typeof m.apiKeyEnv !== 'string') fail(`model ${m.name}: apiKeyEnv must be a string`);
      spec.apiKeyEnv = m.apiKeyEnv;
    }
    if (m.slots !== undefined && m.slots !== null) {
      if (typeof m.slots !== 'number' || !Number.isInteger(m.slots) || m.slots < 1) {
        fail(`model ${m.name}: slots must be a positive integer`);
      }
      spec.slots = m.slots;
    }
    for (const k of ['contextWindow', 'maxTokens'] as const) {
      if (m[k] !== undefined && m[k] !== null) {
        if (typeof m[k] !== 'number' || !Number.isFinite(m[k])) fail(`model ${m.name}: ${k} must be a number`);
        spec[k] = m[k];
      }
    }
    if (m.temperature !== undefined && m.temperature !== null) {
      if (typeof m.temperature !== 'number') fail(`model ${m.name}: temperature must be a number`);
      spec.temperature = m.temperature;
    }
    if (m.deny !== undefined && m.deny !== null) {
      if (!Array.isArray(m.deny)) fail(`model ${m.name}: deny must be a list of tool names`);
      const deny: string[] = [];
      for (const t of m.deny) {
        if (typeof t !== 'string' || !t) fail(`model ${m.name}: deny entries must be tool names`);
        if (UNDENIABLE_TOOLS.includes(t)) fail(`model ${m.name}: cannot deny "${t}" (tasks need it to end)`);
        const classErr = denyEntryError(t);
        if (classErr) fail(`model ${m.name}: ${classErr}`);
        if (known && !t.startsWith('class:') && !known.has(t)) fail(`model ${m.name}: deny names unknown tool "${t}"`);
        if (!deny.includes(t)) deny.push(t);
      }
      if (deny.length) spec.deny = deny;
    }
    models.push(spec);
  });

  if (!raw.roles || typeof raw.roles !== 'object' || Array.isArray(raw.roles)) {
    fail(`models config ${filePath}: missing "roles" mapping`);
  }
  const roles: Record<string, string> = {};
  for (const [role, target] of Object.entries(raw.roles as Record<string, unknown>)) {
    if (typeof target !== 'string' || !target) fail(`role "${role}": must name a model`);
    if (!names.has(target)) fail(`role "${role}" names unknown model "${target}"`);
    roles[role] = target;
  }
  if (!roles.default) fail(`models config ${filePath}: roles.default is required`);
  return { models, roles };
}

/** Counting semaphore shared by every LLM on one baseUrl. */
class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private readonly max: number) {}
  acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }
  release(): void {
    const next = this.queue.shift();
    if (next) next(); // slot handed over directly; active stays the same
    else this.active--;
  }
}

function wrapLimited(inner: LLM, sem: Semaphore): LLM {
  return {
    async chat(req) {
      await sem.acquire();
      try {
        return await inner.chat(req);
      } finally {
        sem.release();
      }
    },
  };
}

export class ModelRegistry {
  private cfg: ModelsConfig;
  private byName: Map<string, ModelSpec>;
  private semaphores = new Map<string, Semaphore>();
  private llms = new Map<string, LLM>();
  private env: Record<string, string | undefined>;
  private factory: (spec: ModelSpec, apiKey: string | undefined) => LLM;

  constructor(
    cfg: ModelsConfig,
    o?: {
      path?: string;
      env?: Record<string, string | undefined>;
      llmFactory?: (spec: ModelSpec, apiKey: string | undefined) => LLM;
    },
  ) {
    this.cfg = cfg;
    this.byName = new Map(cfg.models.map((m) => [m.name, m]));
    this.env = o?.env ?? process.env;
    this.factory =
      o?.llmFactory ??
      ((spec, apiKey) =>
        openaiLLM({
          baseUrl: `${spec.baseUrl}/v1`, // '/v1' is appended by the client
          model: spec.model,
          apiKey,
          temperature: spec.temperature,
        }));
    this.path = o?.path;
  }

  private path: string | undefined;

  /** The file this registry was loaded from (and persists to), if any. */
  configPath(): string | undefined {
    return this.path;
  }

  /** ref = model name, else role name; undefined → roles.default. Unknown → ModelConfigError. */
  resolve(ref?: string): ModelSpec {
    const key = ref ?? this.cfg.roles.default;
    if (!key) fail(`no model reference and no roles.default`);
    const direct = this.byName.get(key);
    if (direct) return direct;
    const viaRole = this.cfg.roles[key];
    if (viaRole) {
      const spec = this.byName.get(viaRole);
      if (spec) return spec;
      fail(`role "${key}" names unknown model "${viaRole}"`);
    }
    fail(`unknown model or role: "${key}"`);
  }

  /** Cached per spec; concurrency-limited per endpoint (max slots of models on that baseUrl). */
  llm(ref?: string): LLM {
    const spec = this.resolve(ref);
    let llm = this.llms.get(spec.name);
    if (!llm) {
      const apiKey = spec.apiKeyEnv ? this.env[spec.apiKeyEnv] : undefined;
      const inner = this.factory(spec, apiKey);
      let sem = this.semaphores.get(spec.baseUrl);
      if (!sem) {
        const size = Math.max(
          ...this.cfg.models.filter((m) => m.baseUrl === spec.baseUrl).map((m) => m.slots ?? DEFAULT_SLOTS),
        );
        sem = new Semaphore(size);
        this.semaphores.set(spec.baseUrl, sem);
      }
      llm = wrapLimited(inner, sem);
      this.llms.set(spec.name, llm);
    }
    return llm;
  }

  list(): { name: string; baseUrl: string; model: string; roles: string[]; deny: string[] }[] {
    return this.cfg.models.map((m) => ({
      name: m.name,
      baseUrl: m.baseUrl,
      model: m.model,
      roles: Object.keys(this.cfg.roles).filter((r) => this.cfg.roles[r] === m.name),
      deny: [...(m.deny ?? [])],
    }));
  }

  /** Tools denied on the model `ref` resolves to. Unknown ref → empty (the call itself fails elsewhere). */
  denied(ref?: string): Set<string> {
    try {
      return new Set(this.resolve(ref).deny ?? []);
    } catch {
      return new Set();
    }
  }

  roles(): Record<string, string> {
    return { ...this.cfg.roles };
  }

  /** Switch a role at runtime; persists to `path` (parse → modify → stringify), keeping the file's other content. */
  setRole(role: string, modelName: string): void {
    if (!this.byName.has(modelName)) fail(`cannot set role "${role}": unknown model "${modelName}"`);
    this.cfg = { models: this.cfg.models, roles: { ...this.cfg.roles, [role]: modelName } };
    if (this.path) {
      let doc: any;
      try {
        doc = parse(readFileSync(this.path, 'utf8'));
      } catch (e: any) {
        fail(`setRole: cannot read ${this.path}: ${e?.message ?? String(e)}`);
      }
      if (!doc || typeof doc !== 'object') doc = {};
      doc.roles = { ...(doc.roles ?? {}), [role]: modelName };
      writeFileSync(this.path, stringify(doc));
    }
  }

  /** Re-read `path`; a bad file keeps the old config and throws. */
  reload(): void {
    if (!this.path) fail('reload: registry has no path');
    const cfg = loadModels(this.path); // throws ModelConfigError, leaves state untouched
    this.cfg = cfg;
    this.byName = new Map(cfg.models.map((m) => [m.name, m]));
    this.semaphores = new Map();
    this.llms = new Map();
  }
}
