// Pure helpers for the board view (P17b). No DOM, no fetching — unit-testable.

export const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'];
const PRIO_RANK = { urgent: 4, high: 3, medium: 2, low: 1, none: 0, '': -1 };

/** Toolbar filter: title/key/label contains (case-insensitive) + optional "Mine" (assignee quinn). */
export function filterItems(items, { text = '', mine = false, me = 'quinn' } = {}) {
  const t = String(text).trim().toLowerCase();
  return (items ?? []).filter((it) => {
    if (mine && it.assignee !== me) return false;
    if (!t) return true;
    if (String(it.title ?? '').toLowerCase().includes(t)) return true;
    if (String(it.key ?? '').toLowerCase().includes(t)) return true;
    return (it.labels ?? []).some((l) => String(l).toLowerCase().includes(t));
  });
}

/** items → Map columnId → items sorted by rank. Items in unknown columns are dropped from the map. */
export function groupByColumn(items, columns) {
  const byCol = new Map((columns ?? []).map((c) => [c.id, []]));
  for (const it of items ?? []) {
    const list = byCol.get(it.columnId);
    if (list) list.push(it);
  }
  for (const list of byCol.values()) list.sort((a, b) => a.rank - b.rank);
  return byCol;
}

/** True when a column holds more items than its WIP limit. */
export const overWip = (col, n) => col?.wip != null && col.wip >= 0 && n > col.wip;

/** "2/5" when there is a checklist, else null. */
export function checklistProgress(item) {
  const list = item?.checklist ?? [];
  if (!list.length) return null;
  return `${list.filter((c) => c.done).length}/${list.length}`;
}

export const parseLabels = (s) => String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

/** Merge a new entry onto an existing checklist (the API PATCH replaces the whole list). */
export const appendChecklist = (list, text) => [
  ...(list ?? []),
  { id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, text: String(text), done: false },
];

export const toggleChecklist = (list, id) => (list ?? []).map((c) => (c.id === id ? { ...c, done: !c.done } : c));

export const removeChecklist = (list, id) => (list ?? []).filter((c) => c.id !== id);

const cmpStr = (a, b) => String(a ?? '').localeCompare(String(b ?? ''));

/** Sort list-view rows. `columns` gives the status order. Unknown keys keep input order. */
export function sortItems(items, key, dir = 1, columns = []) {
  const colIndex = new Map((columns ?? []).map((c, i) => [c.id, i]));
  const list = (items ?? []).slice();
  if (!key) return list;
  const val = {
    key: (it) => it.key,
    title: (it) => it.title,
    status: (it) => colIndex.has(it.columnId) ? colIndex.get(it.columnId) : 1e6,
    priority: (it) => PRIO_RANK[it.priority] ?? 0,
    assignee: (it) => it.assignee,
    due: (it) => it.due,
    labels: (it) => (it.labels ?? []).join(','),
    updated: (it) => it.updatedAt ?? 0,
  }[key];
  if (!val) return list;
  const empty = { assignee: 1, due: 1 }; // empties sort last regardless of direction
  list.sort((a, b) => {
    const va = val(a); const vb = val(b);
    if (empty[key]) {
      if ((va == null || va === '') !== (vb == null || vb === '')) return va == null || va === '' ? 1 : -1;
      if (va == null || va === '') return 0;
    }
    const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : cmpStr(va, vb);
    return c * dir || cmpStr(a.key, b.key);
  });
  return list;
}

/** Suggestions for the assignee input: quinn, alfred, agent:<persona>. */
export function assigneeSuggestions(personas) {
  const names = (personas ?? []).map((p) => (typeof p === 'string' ? p : p.name)).filter(Boolean);
  const out = ['quinn'];
  if (!names.includes('alfred')) out.push('alfred');
  for (const n of names) if (n !== 'alfred') out.push(`agent:${n}`);
  return out;
}

const slug = (s) => String(s ?? '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Unique column id for a new column named `name`, avoiding `taken`. */
export function newColumnId(name, taken = []) {
  const used = new Set(taken);
  const base = slug(name) || 'column';
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}

/**
 * The id of the card the dragged card should land in front of, or null = end of column.
 * `hitId` = card under the pointer (null/unknown → end); `before` = pointer above its midpoint.
 */
export function dropBefore(list, hitId, before) {
  const arr = list ?? [];
  const i = arr.findIndex((x) => x.id === hitId);
  if (i < 0) return null;
  const j = before ? i : i + 1;
  return arr[j] ? arr[j].id : null;
}
