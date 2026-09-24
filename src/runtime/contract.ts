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
}

export interface ToolResult {
  ok: boolean;
  /** What the model sees. Implementations truncate to <= 8000 chars. */
  output: string;
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
