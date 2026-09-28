// J1 §4 — import: Jira → board. One search call per sync; items are matched by their
// `jira` field (the issue URL). Updates only what changed in Jira (title/due/priority);
// done issues move to the board's done column. Never deletes items, never writes to Jira.
import type { ModuleDeps } from '../modules.js';
import type { Board, Item, Priority } from '../board/board.js';
import type { JiraClient, JiraIssue } from './client.js';
import type { JiraPolicy } from './config.js';

export interface SyncResult {
  created: string[];
  updated: string[];
  closed: string[];
  errors: string[];
}

/** Minimal board-item shape unit tests use instead of the real Board (structural subset of Item). */
export interface FakeItem {
  key: string;
  boardId: string;
  title: string;
  description: string;
  status: string;
  kind: 'todo' | 'indeterminate' | 'done';
  priority: Priority;
  labels: string[];
  due: string | null;
  fields: Record<string, any>;
  archived: boolean;
}

export const JIRA_FIELD = { id: 'jira', name: 'Jira', type: 'url' } as const;

export function mapPriority(p: string | null): Priority {
  if (p === 'Highest' || p === 'Blocker') return 'urgent';
  if (p === 'High') return 'high';
  if (p === 'Medium') return 'medium';
  if (p === 'Low' || p === 'Lowest') return 'low';
  return 'none';
}

export async function syncJira(deps: ModuleDeps, board: Board, client: JiraClient, policy: JiraPolicy): Promise<SyncResult> {
  const out: SyncResult = { created: [], updated: [], closed: [], errors: [] };
  let def;
  try {
    def = policy.import.board ? board.getBoard(policy.import.board) : board.defaultBoard();
  } catch (e: any) {
    out.errors.push(`board: ${e?.message ?? e}`);
    return out;
  }
  if (!def) {
    out.errors.push(`no such board: ${policy.import.board || '(default)'}`);
    return out;
  }
  if (!(def.fields ?? []).some((f) => f.id === JIRA_FIELD.id)) {
    try {
      board.updateBoard(def.key, { fields: [...(def.fields ?? []), { ...JIRA_FIELD }] });
    } catch (e: any) {
      out.errors.push(`jira field: ${e?.message ?? e}`);
      return out;
    }
  }
  let issues: JiraIssue[] = [];
  try {
    ({ issues } = await client.search(policy.import.jql, policy.import.max));
  } catch (e: any) {
    out.errors.push(`search: ${e?.message ?? e}`);
    return out;
  }
  const existing = board.listItems({ board: def.key });
  const byUrl = new Map<string, Item>();
  for (const it of existing) {
    const url = it.fields?.[JIRA_FIELD.id];
    if (typeof url === 'string' && url) byUrl.set(url, it);
  }
  for (const iss of issues) {
    try {
      const it = byUrl.get(iss.url);
      if (!it) {
        if (iss.statusCategory === 'done') continue;
        board.createItem(
          {
            board: def.key,
            title: `${iss.key} ${iss.summary}`,
            description: iss.url,
            labels: ['jira', iss.project.toLowerCase()],
            priority: mapPriority(iss.priority),
            due: iss.due ?? null,
            fields: { [JIRA_FIELD.id]: iss.url },
          },
          'jira',
        );
        out.created.push(iss.key);
        continue;
      }
      const patch: Record<string, any> = {};
      const wantTitle = `${iss.key} ${iss.summary}`;
      if (it.title !== wantTitle) patch.title = wantTitle;
      if ((it.due ?? null) !== (iss.due ?? null)) patch.due = iss.due ?? null;
      const wantPrio = mapPriority(iss.priority);
      if ((it.priority ?? 'none') !== wantPrio) patch.priority = wantPrio;
      if (Object.keys(patch).length) {
        board.updateItem(it.key, patch, 'jira');
        out.updated.push(iss.key);
      }
      if (iss.statusCategory === 'done' && it.kind !== 'done') {
        const d = board.getBoard(it.boardId) ?? def;
        const doneCol = d.columns.find((c) => c.kind === 'done');
        if (doneCol && doneCol.name !== it.status) {
          board.moveItem(it.key, { status: doneCol.name }, 'jira');
          out.closed.push(iss.key);
        }
      }
    } catch (e: any) {
      out.errors.push(`${iss.key}: ${e?.message ?? e}`);
    }
  }
  return out;
}
