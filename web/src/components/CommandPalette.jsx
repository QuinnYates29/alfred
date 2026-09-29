// ⌘K palette: jump to views, goals and board items; run quick actions; D1 — `!<persona> <task>` runs an agent.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { go } from '../lib/router.js';
import { Icon } from '../ui/index.jsx';

const NAV = [
  ['Home', '/', 'home'], ['Inbox', '/inbox', 'inbox'], ['Agents', '/agents', 'activity'], ['Board', '/board', 'board'], ['Goals', '/goals', 'goal'],
  ['Chat', '/chat', 'chat'], ['Automations', '/automations', 'clock'], ['System', '/system', 'server'], ['Deck', '/deck', 'deck'],
];

/** Client-side copy of src/dispatch.ts parseDispatch: `!<persona> <prompt>`, `! <prompt>` → alfred. */
export function parseDispatchClient(text, personas) {
  const t = String(text ?? '').trim();
  if (!/^!(?!!)/.test(t)) return null;
  const rest = t.slice(1).trim();
  if (!rest) return null;
  const known = new Map(personas.map((p) => [String(p).toLowerCase(), String(p)]));
  const m = /^@?([A-Za-z0-9][A-Za-z0-9_.-]*)(?:\s+([\s\S]*))?$/.exec(rest);
  if (m) {
    const canonical = known.get(m[1].toLowerCase());
    if (canonical && (m[2] ?? '').trim()) return { persona: canonical, prompt: m[2].trim() };
  }
  return { persona: 'alfred', prompt: rest };
}

export default function CommandPalette({ onClose, actions }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [goals, setGoals] = useState([]);
  const [items, setItems] = useState([]);
  const [personas, setPersonas] = useState([]);
  const [err, setErr] = useState(null);
  const ref = useRef(null);
  useEffect(() => {
    api('/api/goals').then(setGoals).catch(() => {});
    api('/api/items?limit=300').then(setItems).catch(() => {});
    api('/api/personas').then((p) => setPersonas((p ?? []).map((x) => x.name))).catch(() => {});
    ref.current?.focus();
  }, []);

  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    const hit = (t) => !s || String(t).toLowerCase().includes(s);
    const out = [];
    const dispatch = (body) => () => {
      // keepOpen: stay open on error and show the message; only navigate (and close) on success
      api('/api/v1/dispatch', { method: 'POST', body }).then(
        (r) => { onClose(); go(`/goal/${r.goal.id}`); },
        (e) => setErr(e?.message ?? String(e)),
      );
    };
    const dispatchParse = parseDispatchClient(q, personas);
    if (q.trim().startsWith('!')) {
      if (dispatchParse) {
        out.push({
          label: `Dispatch to ${dispatchParse.persona}: “${dispatchParse.prompt}”`,
          icon: 'zap', hint: 'run', keepOpen: true,
          run: dispatch({ text: q }),
        });
      }
      return out;
    }
    for (const a of actions) if (hit(a.label)) out.push({ ...a, hint: 'action' });
    for (const [label, path, icon] of NAV) if (hit(label)) out.push({ label: `Go to ${label}`, icon, run: () => go(path), hint: 'view' });
    for (const it of items) if (s && (hit(it.title) || hit(it.key))) out.push({ label: `${it.key} ${it.title}`, icon: 'board', run: () => go(`/board/${it.key}`), hint: it.status });
    for (const g of goals) if (s && (hit(g.title) || hit(g.slug))) out.push({ label: g.title, icon: 'goal', run: () => go(`/goal/${g.id}`), hint: g.status });
    if (s) {
      out.push({ label: `Ask alfred: “${q.trim()}”`, icon: 'chat', run: () => go('/chat', { ask: q.trim() }), hint: 'chat' });
      for (const name of personas) {
        out.push({ label: `Run with ${name}: “${q.trim()}”`, icon: 'zap', hint: 'run', keepOpen: true, run: dispatch({ prompt: q.trim(), persona: name }) });
      }
    }
    return out.slice(0, 40);
  }, [q, goals, items, actions, personas, onClose]);

  const goRun = (r) => {
    setErr(null);
    if (!r?.keepOpen) onClose(); // dispatch rows close themselves, only on success
    r?.run();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === 'Enter') goRun(results[sel]);
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <input ref={ref} value={q} onChange={(e) => { setQ(e.target.value); setSel(0); setErr(null); }} onKeyDown={onKey}
          placeholder="Search, jump, ask alfred — or !coder <task> to run an agent…" aria-label="Command" />
        {err && <div className="error small">{err}</div>}
        <div className="results">
          {results.map((r, i) => (
            <button key={i} className={`res ${i === sel ? 'sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => goRun(r)}>
              <Icon name={r.icon ?? 'zap'} size={15} />
              <span className="ellipsis">{r.label}</span>
              <span className="hint">{r.hint}</span>
            </button>
          ))}
          {!results.length && <div className="empty small">No matches</div>}
        </div>
      </div>
    </div>
  );
}
