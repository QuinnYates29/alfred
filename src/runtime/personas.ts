// P1 — persona loading from YAML and prompt-cost budgeting.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { PersonaBudgetError, PersonaConfigError, type Persona } from './contract.js';
import { estimateTokens } from './tokens.js';
import type { ToolRegistry } from './tools.js';

/** estimateTokens(system) + estimateTokens(JSON of the persona's tool schemas). */
export function promptCost(p: Persona, reg: ToolRegistry): number {
  return (
    estimateTokens(p.system) + estimateTokens(JSON.stringify(reg.schemasFor(p.tools)))
  );
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function parsePersona(file: string, reg: ToolRegistry): Persona {
  const raw = parse(readFileSync(file, 'utf8')) as any;
  const base = path.basename(file, path.extname(file));
  const fail = (msg: string): never => {
    throw new PersonaConfigError(`persona ${base}: ${msg}`);
  };
  if (!raw || typeof raw !== 'object') fail('not a YAML mapping');
  const name = asString(raw.name) ?? fail('missing name');
  if (name !== base) fail(`name "${name}" != file basename "${base}"`);
  const description = asString(raw.description) ?? fail('missing description');
  const system = asString(raw.system) ?? fail('missing system');
  if (!Array.isArray(raw.tools)) fail('missing tools');
  const tools = raw.tools.map((t: unknown) => asString(t) ?? fail('tools must be strings'));
  if (typeof raw.promptBudgetTokens !== 'number' || !Number.isFinite(raw.promptBudgetTokens)) {
    fail('missing promptBudgetTokens');
  }
  if (!Array.isArray(raw.canSpawn)) fail('missing canSpawn');
  const canSpawn = raw.canSpawn.map((c: unknown) => asString(c) ?? fail('canSpawn must be strings'));
  if (tools.includes('spawn_subagent') !== canSpawn.length > 0) {
    fail('spawn_subagent in tools and a non-empty canSpawn must go together');
  }
  const p: Persona = {
    name,
    description,
    system,
    tools,
    promptBudgetTokens: raw.promptBudgetTokens,
    canSpawn,
  };
  if (raw.maxTokensPerTurn !== undefined && raw.maxTokensPerTurn !== null) {
    if (typeof raw.maxTokensPerTurn !== 'number') fail('maxTokensPerTurn must be a number');
    p.maxTokensPerTurn = raw.maxTokensPerTurn;
  }
  // Unknown tool names throw PersonaConfigError via schemasFor.
  const cost = promptCost(p, reg);
  if (cost > p.promptBudgetTokens) {
    throw new PersonaBudgetError(
      `persona ${name}: prompt cost ${cost} exceeds budget ${p.promptBudgetTokens}`,
    );
  }
  return p;
}

/** Load every *.yaml in dir; validates config and budgets. Throws on the first problem. */
export function loadPersonas(dir: string, reg: ToolRegistry): Map<string, Persona> {
  const personas = new Map<string, Persona>();
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;
    const p = parsePersona(path.join(dir, entry), reg);
    personas.set(p.name, p);
  }
  for (const p of personas.values()) {
    for (const target of p.canSpawn) {
      if (!personas.has(target)) {
        throw new PersonaConfigError(`persona ${p.name}: canSpawn names unknown persona "${target}"`);
      }
    }
  }
  return personas;
}
