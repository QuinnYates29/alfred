// P0 markdown mirror. Deterministic: never touches the wall clock.
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './store.js';

const FAILURE_LIKE = new Set(['failed', 'stopped', 'blocked']);

export function writeMirror(store: Store, goalId: string, dir: string): string {
  const goal = store.getGoal(goalId);
  if (!goal) throw new Error(`no such goal: ${goalId}`);
  const tasks = store.listTasks(goalId);
  const recentEvents = store.events(goalId).slice(-20);

  const lines: string[] = [];
  lines.push(`# ${goal.title}`);
  lines.push('');
  lines.push(`Status: **${goal.status.toUpperCase()}**`);
  lines.push('');
  if (goal.body) {
    lines.push(goal.body);
    lines.push('');
  }

  lines.push('## Acceptance');
  lines.push('');
  if (goal.acceptance.length === 0) {
    lines.push('_none_');
  } else {
    for (const c of goal.acceptance) {
      lines.push(`- **${c.name}**: \`${c.cmd}\``);
    }
  }
  lines.push('');

  lines.push('## Tasks');
  lines.push('');
  lines.push('| Title | Persona | Status | Attempt | Reason |');
  lines.push('|---|---|---|---|---|');
  for (const t of tasks) {
    lines.push(`| ${t.title} | ${t.persona} | ${t.status} | ${t.attempt} | ${t.reason ?? ''} |`);
  }
  lines.push('');

  const failing = tasks.filter((t) => FAILURE_LIKE.has(t.status));
  if (failing.length > 0) {
    lines.push('## Failures');
    lines.push('');
    for (const t of failing) {
      lines.push(`> [!failure] ${t.title}`);
      lines.push(`> ${t.reason ?? '(no reason given)'}`);
      lines.push('');
    }
  }

  lines.push('## Recent events');
  lines.push('');
  if (recentEvents.length === 0) {
    lines.push('_none_');
  } else {
    for (const e of recentEvents) {
      lines.push(`- [${e.ts}] ${e.kind} ${JSON.stringify(e.data)}`);
    }
  }
  lines.push('');

  const content = lines.join('\n');

  const goalDir = join(dir, goal.slug);
  mkdirSync(goalDir, { recursive: true });
  const finalPath = join(goalDir, 'GOAL.md');
  const tmpPath = join(goalDir, `.GOAL.md.${process.pid}.tmp`);
  writeFileSync(tmpPath, content, 'utf8');
  renameSync(tmpPath, finalPath);
  return finalPath;
}
