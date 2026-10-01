// P15 — a task's transcript: the event kinds that tell the story of a run.
import type { Store } from '../store.js';

export const TRANSCRIPT_KINDS = [
  'workspace', 'turn', 'tool', 'progress', 'transition', 'verify',
  'pushed', 'push_failed', 'compacted', 'approval_requested', 'approval_decided',
];

export function transcriptFor(store: Store, taskId: string): { id: number; ts: number; kind: string }[] {
  const out: any[] = [];
  // The task's goal's events: `allEvents()` is the first 500 events ever recorded, so every task
  // after those had an empty transcript.
  const goalId = store.getTask(taskId)?.goalId;
  for (const e of goalId ? store.events(goalId) : []) {
    if (e.taskId !== taskId || !TRANSCRIPT_KINDS.includes(e.kind)) continue;
    out.push({ id: e.id, ts: e.ts, kind: e.kind, ...(e.data && typeof e.data === 'object' ? e.data : {}) });
  }
  return out;
}
