// P13 §6 — goal ↔ item sync. Listens to store events; never throws.
import type { Store } from '../store.js';
import type { Board } from './board.js';

export function startBoardSync(store: Store, board: Board): () => void {
  return store.onEvent((e) => {
    try {
      if (e.kind === 'goal_status') applyGoalStatus(store, board, e.goalId, e.data?.status);
    } catch {
      // Sync must never break the runtime.
    }
  });
}

function linkedItems(store: Store, board: Board, goalId: string) {
  const items = board.itemsForGoal(goalId);
  if (items.length) return items;
  const metaItem = store.getGoal(goalId)?.meta?.item;
  if (typeof metaItem === 'string' && metaItem) {
    const it = board.getItem(metaItem);
    return it ? [it] : [];
  }
  return [];
}

function applyGoalStatus(store: Store, board: Board, goalId: string, status: string | undefined) {
  if (status !== 'done' && status !== 'failed' && status !== 'active') return;
  const items = linkedItems(store, board, goalId);
  if (!items.length) return;
  const goal = store.getGoal(goalId);
  if (!goal) return;
  const tasks = store.listTasks(goalId);

  if (status === 'active') {
    for (const it of items) {
      if (it.labels.includes('needs-attention')) {
        board.updateItem(it.key, { labels: it.labels.filter((l) => l !== 'needs-attention') }, 'alfred');
      }
    }
    return;
  }

  if (status === 'failed') {
    const bad = tasks.find((t) => t.status === 'failed' || t.status === 'stopped');
    const reason = bad?.reason ?? 'unknown';
    for (const it of items) {
      board.comment(it.key, 'alfred', `Goal ${goal.slug} failed: ${reason}`);
      if (!it.labels.includes('needs-attention')) {
        board.updateItem(it.key, { labels: [...it.labels, 'needs-attention'] }, 'alfred');
      }
    }
    return;
  }

  // done
  for (const it of items) {
    const def = board.getBoard(it.boardId);
    const pushed = store.events(goalId).some((ev) => ev.kind === 'pushed');
    const reviewCol = def?.columns.find((c) => c.kind === 'review');
    const target = pushed && reviewCol ? 'review' : 'done';
    if (it.kind !== target) board.moveItem(it.key, { status: target }, 'alfred');
    const root = tasks.find((t) => !t.parentTaskId) ?? tasks[0];
    const summary = root?.result && root.result.trim() ? root.result.trim() : `Goal ${goal.slug} finished`;
    const already = board.comments(it.key).some((c) => c.body.includes(summary));
    if (!already) board.comment(it.key, 'alfred', summary);
  }
}
