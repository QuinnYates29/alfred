// ⌘K palette: jump to views, goals and board items; run quick actions.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { go } from '../lib/router.js';
import { Icon } from '../ui/index.jsx';

const NAV = [
  ['Home', '/', 'home'], ['Inbox', '/inbox', 'inbox'], ['Board', '/board', 'board'], ['Goals', '/goals', 'goal'],
  ['Chat', '/chat', 'chat'], ['Automations', '/automations', 'clock'], ['System', '/system', 'server'], ['Deck', '/deck', 'deck'],
];

export default function CommandPalette({ onClose, actions }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [goals, setGoals] = useState([]);
  const [items, setItems] = useState([]);
  const ref = useRef(null);
  useEffect(() => {
    api('/api/goals').then(setGoals).catch(() => {});
    api('/api/items?limit=300').then(setItems).catch(() => {});
    ref.current?.focus();
  }, []);

  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    const hit = (t) => !s || String(t).toLowerCase().includes(s);
    const out = [];
    for (const a of actions) if (hit(a.label)) out.push({ ...a, hint: 'action' });
    for (const [label, path, icon] of NAV) if (hit(label)) out.push({ label: `Go to ${label}`, icon, run: () => go(path), hint: 'view' });
    for (const it of items) if (s && (hit(it.title) || hit(it.key))) out.push({ label: `${it.key} ${it.title}`, icon: 'board', run: () => go(`/board/${it.key}`), hint: it.status });
    for (const g of goals) if (s && (hit(g.title) || hit(g.slug))) out.push({ label: g.title, icon: 'goal', run: () => go(`/goal/${g.id}`), hint: g.status });
    if (s) out.push({ label: `Ask alfred: “${q.trim()}”`, icon: 'chat', run: () => go('/chat', { ask: q.trim() }), hint: 'chat' });
    return out.slice(0, 40);
  }, [q, goals, items, actions]);

  const run = (r) => {
    onClose();
    r?.run();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === 'Enter') run(results[sel]);
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <input ref={ref} value={q} onChange={(e) => { setQ(e.target.value); setSel(0); }} onKeyDown={onKey}
          placeholder="Search goals and items, jump to a view, or ask alfred…" aria-label="Command" />
        <div className="results">
          {results.map((r, i) => (
            <button key={i} className={`res ${i === sel ? 'sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => run(r)}>
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
