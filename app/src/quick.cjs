'use strict';
// P18 §4 — quick-add grammar (pure parseQuick) + submit through the API client.

const pad = (n) => String(n).padStart(2, '0');
const isoLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * `!coder …` (D1: `!<persona> <prompt>` directly after the bang) → run ·
 * `! …` (bang + space) → goal (the p18 quick-goal, kept) · `? …` → ask · otherwise an item
 * with inline #label, !!/!!! and @today/@tomorrow/@YYYY-MM-DD.
 * @param {string} text
 * @param {Date} [now]
 */
function parseQuick(text, now = new Date()) {
  const t = String(text ?? '').trim();
  if (!t) return { kind: 'none' };

  // D1: `!` immediately followed by non-space dispatches an agent: `!coder fix x`.
  if (/^!(?![\s!])[\s\S]+$/.test(t)) return { kind: 'run', text: t };
  const goal = /^!(?!!)\s*([\s\S]*)$/.exec(t);
  if (goal) {
    const title = goal[1].trim();
    return title ? { kind: 'goal', title } : { kind: 'none' };
  }
  const ask = /^\?\s*([\s\S]*)$/.exec(t);
  if (ask) {
    const q = ask[1].trim();
    return q ? { kind: 'ask', text: q } : { kind: 'none' };
  }

  const out = { kind: 'item', title: '' };
  const labels = [];
  const words = [];
  for (const w of t.split(/\s+/)) {
    let m;
    if ((m = /^#([\w][\w.\-/]*)$/.exec(w))) {
      if (!labels.includes(m[1])) labels.push(m[1]);
    } else if (w === '!!!') out.priority = 'urgent';
    else if (w === '!!') {
      if (out.priority !== 'urgent') out.priority = 'high';
    } else if (/^@today$/i.test(w)) out.due = isoLocal(now);
    else if (/^@tomorrow$/i.test(w)) out.due = isoLocal(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
    else if ((m = /^@(\d{4}-\d{2}-\d{2})$/.exec(w))) out.due = m[1];
    else words.push(w);
  }
  out.title = words.join(' ');
  if (labels.length) out.labels = labels;
  if (!out.title) return { kind: 'none' };
  return out;
}

/** Parse + submit; returns the result line (`Created ALF-3`, `Started coder → <slug>`, the reply, or `⚠ …`). */
async function submitQuick(text, api) {
  const q = parseQuick(text);
  try {
    if (q.kind === 'none') return '⚠ nothing to add';
    if (q.kind === 'run') {
      const r = await api.request('POST', '/api/v1/dispatch', { text: q.text, source: 'mac-quick' });
      return `Started ${r?.persona ?? 'alfred'} → ${r?.goal?.slug ?? r?.goal?.id ?? ''}`.trim();
    }
    if (q.kind === 'goal') {
      const r = await api.request('POST', '/api/v1/goals', { title: q.title, persona: 'alfred', spec: q.title });
      return `Started goal ${r?.goal?.slug ?? r?.goal?.id ?? q.title}`;
    }
    if (q.kind === 'ask') {
      const r = await api.request('POST', '/api/v1/chat', { text: q.text }, { timeoutMs: 180_000 });
      const reply = r?.reply;
      const content = typeof reply === 'string' ? reply : reply?.content ?? '';
      return content.trim().slice(0, 200) || '(no reply)';
    }
    const body = { title: q.title };
    if (q.labels) body.labels = q.labels;
    if (q.priority) body.priority = q.priority;
    if (q.due) body.due = q.due;
    const item = await api.request('POST', '/api/v1/items', body);
    return `Created ${item?.key ?? 'item'}`;
  } catch (e) {
    return `⚠ ${e?.message ?? String(e)}`;
  }
}

module.exports = { parseQuick, submitQuick, isoLocal };
