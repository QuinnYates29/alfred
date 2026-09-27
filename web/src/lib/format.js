// Formatting helpers shared by every view.

export function timeAgo(ts, now = Date.now()) {
  if (!ts) return '';
  const s = Math.round((now - ts) / 1000);
  if (s < 0) return 'in ' + duration(-s * 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** 95000 → "1m 35s", 7_300_000 → "2h 1m" */
export function duration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

export const clock = (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const dateTime = (ts) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** 1234567 → "1.2M", 12345 → "12.3k" */
export function compact(n) {
  if (n == null || Number.isNaN(n)) return '–';
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (a >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(n));
}

/** "2026-10-01" → "Oct 1" (+ overdue/today flags) */
export function dueInfo(due, now = new Date()) {
  if (!due) return null;
  const [y, m, d] = due.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((date - today) / 86400000);
  const label = days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days === -1 ? 'Yesterday'
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(y !== now.getFullYear() ? { year: 'numeric' } : {}) });
  return { label, days, overdue: days < 0, soon: days >= 0 && days <= 2 };
}

/** Initials for an assignee: 'quinn' → 'Q', 'agent:coder' → 'C'. */
export function initials(who) {
  if (!who) return '';
  const name = String(who).replace(/^agent:/, '');
  return name.slice(0, 1).toUpperCase();
}

export const isAgent = (who) => typeof who === 'string' && (who.startsWith('agent:') || who === 'alfred');
export const shortId = (id) => (id ? String(id).slice(0, 8) : '');

/** Task/goal status → chip tone class (the chip classes in components.css). */
export const TERMINAL = ['done', 'failed', 'stopped'];
export const PARKED = ['blocked', 'needs_claude'];

/** A goal summary needs attention if it failed or has a failed/parked task. */
export function goalNeedsAttention(g) {
  if (!g) return false;
  if (g.status === 'failed') return true;
  const c = g.counts || {};
  return (c.failed || 0) + (c.blocked || 0) + (c.needs_claude || 0) > 0;
}

export function pluralize(n, word, plural) {
  return `${n} ${n === 1 ? word : plural ?? word + 's'}`;
}
