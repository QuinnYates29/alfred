// P1 contract. Written by the orchestrator; implementers build to it and may
// extend it, but must not change the meaning of anything below.

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed JSON arguments. Unparseable arguments arrive as { __raw: string }. */
  args: any;
}

export interface LLMMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[]; // assistant
  toolCallId?: string; // tool
  name?: string; // tool
}

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: any;
}

export interface LLMRequest {
  system: string;
  messages: LLMMessage[];
  tools: ToolSchema[];
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LLMResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: { promptTokens: number; completionTokens: number };
}

export interface LLM {
  chat(req: LLMRequest): Promise<LLMResponse>;
}

/** Everything a tool can touch. Tools never reach outside `workspace` for writes. */
export interface ToolContext {
  taskId: string;
  goalId: string;
  workspace: string;
  persona: string;
  signal: AbortSignal;
  /** The task's acceptance checks (executors use them as their test command). */
  acceptance: import('../types.js').AcceptanceCheck[];
  /** Long-running tools call this to record a `progress` event, which resets the stall watchdog. */
  progress: (msg: string) => void;
  /** P9: where the workspace lives. Absent = this machine's filesystem. */
  backend?: WorkspaceBackend;
}

/** P9: file/exec operations for a workspace that may live on another machine (an alfred-node). */
export interface WorkspaceBackend {
  /** 'local' or the node's name. */
  node: string;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listDir(path: string): Promise<{ name: string; dir: boolean }[]>;
  exec(cmd: string, o: { cwd: string; timeoutMs: number; signal?: AbortSignal }): Promise<{ exitCode: number | null; output: string; timedOut: boolean }>;
}

/** P9: raised by a remote backend when its node is not connected. The runtime parks the task `blocked`. */
export class NodeOfflineError extends Error {
  constructor(public node: string) { super(`node ${node} offline`); }
}

export interface ToolResult {
  ok: boolean;
  /** What the model sees. Implementations truncate to <= 8000 chars. */
  output: string;
  /** Park the task instead of continuing (e.g. an action needs Quinn's approval). The runtime transitions and returns. */
  park?: { status: 'blocked' | 'needs_claude'; reason: string };
}

export interface Tool {
  schema: ToolSchema;
  /** 'control' tools (finish, give_up, ask_claude, spawn_subagent, wait_subtasks) are handled by the runtime. */
  kind: 'read' | 'write' | 'exec' | 'control';
  run(args: any, ctx: ToolContext): Promise<ToolResult>;
}

export interface Persona {
  name: string;
  description: string;
  system: string;
  tools: string[];
  /** Hard cap on estimateTokens(system) + estimateTokens(JSON of the persona's tool schemas). */
  promptBudgetTokens: number;
  /** Personas this one may spawn as subagents. Empty = may not spawn. */
  canSpawn: string[];
  maxTokensPerTurn?: number;
  /** P7: model name or role from config/models.yaml. Default role 'default'. */
  model?: string;
  /** P8: max estimated prompt tokens per LLM call; older history is compacted above this. Default 24000. */
  contextBudgetTokens?: number;
}

export interface WatchdogConfig {
  /** No store event for this task for this long → stopped. */
  stallMs: number;
  /** This many consecutive turns without any tool call → stopped (a model that only talks makes no progress). */
  maxIdleTurns: number;
  /** The same tool error text this many times in a row → failed. */
  maxRepeatedErrors: number;
}

export const DEFAULT_WATCHDOG: WatchdogConfig = {
  stallMs: 15 * 60 * 1000,
  maxIdleTurns: 3,
  maxRepeatedErrors: 3,
};

export class PersonaBudgetError extends Error {}
export class PersonaConfigError extends Error {}
