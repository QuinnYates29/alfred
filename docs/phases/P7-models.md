# P7 — Swappable models

Status: **SPEC** · Branch: `p7-models` · Acceptance: `npx vitest run test/acceptance/p7`
Depends on: P1 (runtime), P2 (executors).

Goal: nothing in the code names a model. Personas, goals and executors refer to a **model name or a role**; `config/models.yaml` maps those
to OpenAI-compatible endpoints. Swapping Qwen for anything else (another llama.cpp model, vLLM, Ollama, OpenRouter) is a yaml edit or one API call.

## `config/models.yaml` (shipped; gitignored copy `config/models.local.yaml` wins if present)
```yaml
models:
  - name: qwen-local
    baseUrl: http://127.0.0.1:1110        # OpenAI-compatible; '/v1' is appended by the client
    model: qwen3.8-flash-next
    slots: 3                               # concurrent calls allowed to THIS endpoint (shared by every model on the same baseUrl)
    contextWindow: 65536
    maxTokens: 8192
  # - name: openrouter-x
  #   baseUrl: https://openrouter.ai/api
  #   model: some/model
  #   apiKeyEnv: OPENROUTER_API_KEY
roles:
  default: qwen-local      # used when nothing else is specified
  planner: qwen-local      # alfred
  coder: qwen-local
  fast: qwen-local
```

## `src/models.ts`
```ts
export interface ModelSpec { name: string; baseUrl: string; model: string; apiKeyEnv?: string; slots?: number /* 3 */;
  contextWindow?: number /* 65536 */; maxTokens?: number; temperature?: number }
export interface ModelsConfig { models: ModelSpec[]; roles: Record<string, string> }
export class ModelConfigError extends Error {}
export function loadModels(path: string): ModelsConfig
  // validates: unique names, required fields, every role points at a defined model, `roles.default` exists. Violations → ModelConfigError.
export class ModelRegistry {
  constructor(cfg: ModelsConfig, o?: { path?: string; env?: Record<string, string | undefined>;
    llmFactory?: (spec: ModelSpec, apiKey: string | undefined) => LLM })   // default factory = openaiLLM
  resolve(ref?: string): ModelSpec          // model name, else role name, else ModelConfigError. undefined → roles.default
  llm(ref?: string): LLM                    // concurrency-limited per baseUrl (one semaphore per endpoint, size = max slots of models on it). Cached per spec.
  list(): { name: string; baseUrl: string; model: string; roles: string[] }[]
  roles(): Record<string, string>
  setRole(role: string, modelName: string): void    // unknown model → ModelConfigError; persists to `path` (if given) preserving the file's other content
  reload(): void                                     // re-read `path`; later llm() calls use the new specs; a bad file keeps the old config and throws
}
```

## Runtime wiring
- `Persona.model?` (already in the contract). Ship personas with `model:` = a role: alfred → `planner`, coder → `coder`, coder-lg → `coder`, researcher → `fast`.
- `RunOpts.models?: ModelRegistry`. When present, each LLM call uses `models.llm(ref)` with `ref = goal.meta.model ?? task.model? ?? persona.model ?? 'default'`
  (resolved **per call**, so a role switch takes effect on the next turn of a running task). `RunOpts.llm` stays the fallback, so existing tests keep working.
- `spawn_subagent` accepts an optional `model` arg, stored in the child task (add `Task.meta` or a `model` column; keep it additive).
- Executors: `langgraphTool` and `pipelineTool` accept `models?: ModelRegistry` and use `models.resolve('coder')` for baseUrl/model (pipeline: every role in
  the generated yaml, `--orchestrator-url <baseUrl>/v1`). `dshTool`: DSH reads its own `~/.dsh/settings.yaml`. Document in README how to point it elsewhere. Not tested.

## Done when
`npx vitest run test/acceptance/p7` plus all earlier suites and typecheck are green on `p7-models`.
