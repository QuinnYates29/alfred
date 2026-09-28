// Shared logic for Home + Inbox (P17d): what needs attention, due-soon, running-now.
// The API has no cross-goal task list, so for the goals that matter we fetch
// GET /api/goals/:id (goal + tasks + events) and pull parked/failed tasks from there.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { useLive } from '../../lib/live.jsx';
import { dueInfo } from '../../lib/format.js';

const parkedCount = (g) => ((g.counts?.blocked ?? 0) + (g.counts?.needs_claude ?? 0));

/** A goal whose detail we need to fetch: parked or failed tasks, or running work. */
export function needsDetail(g) {
  return parkedCount(g) > 0 || (g.counts?.failed ?? 0) > 0 || g.status === 'failed' || (g.counts?.running ?? 0) > 0;
}

/**
 * Fetch details for the given goal ids; refresh on goal/task events and every `interval` ms.
 * Returns { [goalId]: { goal, tasks, events } }.
 */
export function useGoalDetails(ids, { interval } = {}) {
  const key = ids.join(',');
  const [details, setDetails] = useState({});
  const deb = useRef(null);
  const fetchAll = useCallback(() => {
    const list = key ? key.split(',') : [];
    if (!list.length) { setDetails({}); return Promise.resolve(); }
    return Promise.all(list.map((id) => api(`/api/goals/${id}`).then((d) => [id, d], () => null)))
      .then((rs) => setDetails(Object.fromEntries(rs.filter(Boolean))));
  }, [key]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);
  useLive(['transition', 'goal_', 'task_created', 'approval_'], () => {
    clearTimeout(deb.current);
    deb.current = setTimeout(fetchAll, 200);
  });
  useEffect(() => {
    if (!interval || !key) return undefined;
    const t = setInterval(fetchAll, interval);
    return () => { clearInterval(t); clearTimeout(deb.current); };
  }, [fetchAll, interval, key]);
  return details;
}

export const goalHref = (goalId) => `/goal/${goalId}`;

/** Rows for the "Needs you" list + the inbox sections, in priority order. */
export function attentionRows({ approvals = [], items = [], goals = [], details = {} }) {
  const rows = [];
  for (const a of approvals) {
    rows.push({
      key: `ap-${a.id}`, kind: 'approval', icon: 'check', title: a.action || 'Approval request',
      sub: a.detail, goalId: a.goalId, href: goalHref(a.goalId), approval: a,
    });
  }
  for (const g of goals) {
    const d = details[g.id];
    for (const t of d?.tasks ?? []) {
      if (t.status === 'needs_claude') {
        rows.push({ key: `cl-${t.id}`, kind: 'claude', icon: 'bot', title: t.title, sub: t.reason, goalId: g.id, href: goalHref(g.id), task: t });
      } else if (t.status === 'blocked') {
        rows.push({ key: `bl-${t.id}`, kind: 'blocked', icon: 'alert', title: t.title, sub: t.reason, goalId: g.id, href: goalHref(g.id), task: t });
      }
    }
  }
  for (const g of goals) {
    if (g.status !== 'failed') continue;
    rows.push({ key: `fg-${g.id}`, kind: 'failed-goal', icon: 'alert', title: g.title, sub: 'Goal failed', goalId: g.id, href: goalHref(g.id), goal: g });
  }
  for (const it of items) {
    rows.push({ key: `it-${it.id}`, kind: 'item', icon: 'board', title: it.title, sub: it.key, href: `/board/${it.key}`, item: it });
  }
  return rows;
}

/** Board items due within `days` days (or overdue), not done; soonest first. */
export function dueSoon(items, days = 7, now = new Date()) {
  return (items ?? [])
    .filter((it) => it.due && !it.completedAt && it.kind !== 'done')
    .map((it) => ({ it, info: dueInfo(it.due, now) }))
    .filter((x) => x.info && x.info.days <= days)
    .sort((a, b) => a.info.days - b.info.days);
}

/** Active goals that have a running task, with the (first) running task. */
export function runningGoals(goals, details) {
  const out = [];
  for (const g of goals) {
    if ((g.counts?.running ?? 0) === 0) continue;
    const task = (details[g.id]?.tasks ?? []).find((t) => t.status === 'running');
    if (task) out.push({ goal: g, task });
  }
  return out;
}

export function greeting(now = new Date()) {
  const h = now.getHours();
  const word = h < 5 ? 'night' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
  return `Good ${word}, Quinn`;
}

/** Thread title from the first user message (used when creating a thread). */
export const threadTitle = (text) => text.trim().slice(0, 48) || 'New chat';

/** The failed root task of a goal detail payload (for Retry). */
export function failedRootTask(detail) {
  const tasks = detail?.tasks ?? [];
  const root = tasks.find((t) => !t.parentTaskId);
  if (root && root.status === 'failed') return root;
  return tasks.find((t) => t.status === 'failed') ?? null;
}
