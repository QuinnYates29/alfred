// The app shell: sidebar (desktop) / tab bar (phone), top bar, global dialogs, routing.
// Views live in ./views/*.jsx and receive nothing but the route; they fetch their own data with useResource.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { LiveProvider, useLiveState, useResource } from './lib/live.jsx';
import { useRoute, href, go, setQuery } from './lib/router.js';
import { goalNeedsAttention } from './lib/format.js';
import { Button, Icon, ToastProvider } from './ui/index.jsx';
import NewGoalDialog from './components/NewGoalDialog.jsx';
import NewItemDialog from './components/NewItemDialog.jsx';
import CommandPalette from './components/CommandPalette.jsx';
import Home from './views/Home.jsx';
import Inbox from './views/Inbox.jsx';
import Board from './views/Board.jsx';
import Goals from './views/Goals.jsx';
import GoalDetail from './views/GoalDetail.jsx';
import Chat from './views/Chat.jsx';
import Automations from './views/Automations.jsx';
import System from './views/System.jsx';
import Deck from './views/Deck.jsx';

const AppCtx = createContext(null);
/** useApp(): { newGoal(prefill?), newItem(prefill?), palette(), attention: {goals, approvals, items, total} } */
export const useApp = () => useContext(AppCtx);

const NAV = [
  ['/', 'Home', 'home'],
  ['/inbox', 'Inbox', 'inbox'],
  ['/board', 'Board', 'board'],
  ['/goals', 'Goals', 'goal'],
  ['/chat', 'Chat', 'chat'],
  null,
  ['/automations', 'Automations', 'clock'],
  ['/system', 'System', 'server'],
  ['/deck', 'Deck', 'deck'],
];
const TABS = [['/', 'Home', 'home'], ['/inbox', 'Inbox', 'inbox'], ['/board', 'Board', 'board'], ['/goals', 'Goals', 'goal'], ['/chat', 'Chat', 'chat']];

/** Route → view. Legacy hashes from the P5 shell keep working. */
function pick(parts) {
  const [a, b, c] = parts;
  switch (a) {
    case undefined: return <Home />;
    case 'inbox': case 'approvals': return <Inbox />;
    case 'board': return <Board itemKey={b} />;
    case 'goals': return <Goals />;
    case 'goal': return <GoalDetail id={b} tab={c} />;
    case 'chat': return <Chat threadId={b} />;
    case 'automations': return <Automations />;
    case 'system': return <System tab={b} />;
    case 'personas': case 'models': case 'nodes': return <System tab={a} />;
    case 'deck': return <Deck />;
    default: return <div className="page"><h1>Not found</h1><a href="#/">Home</a></div>;
  }
}

function activeFor(path, parts) {
  const a = parts[0];
  if (path === '/') return !a;
  const seg = path.slice(1);
  if (seg === 'inbox') return a === 'inbox' || a === 'approvals';
  if (seg === 'goals') return a === 'goals' || a === 'goal';
  if (seg === 'system') return ['system', 'personas', 'models', 'nodes'].includes(a);
  return a === seg;
}

function useAttention() {
  const goals = useResource('/api/goals', { on: ['goal_', 'transition', 'task_created'] });
  const approvals = useResource('/api/approvals?status=pending', { on: ['approval_'] });
  const items = useResource('/api/items?label=needs-attention', { on: ['item_'] });
  return useMemo(() => {
    const g = (goals.data ?? []).filter(goalNeedsAttention);
    const ap = approvals.data ?? [];
    const it = Array.isArray(items.data) ? items.data : [];
    return { goals: g, approvals: ap, items: it, total: g.length + ap.length + it.length, allGoals: goals.data ?? [] };
  }, [goals.data, approvals.data, items.data]);
}

function Shell() {
  const { path, parts } = useRoute();
  const live = useLiveState();
  const attention = useAttention();
  const [dialog, setDialog] = useState(null); // {kind:'goal'|'item'|'palette', prefill}
  const [navOpen, setNavOpen] = useState(false);
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('alfred.theme') || ''; } catch { return ''; }
  });

  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    try { localStorage.setItem('alfred.theme', theme); } catch { /* private mode */ }
  }, [theme]);
  useEffect(() => setNavOpen(false), [path]);
  // Deep links from the Mac app / CLI: #/…?new=goal | ?new=item opens that dialog once.
  const { query } = useRoute();
  useEffect(() => {
    if (query.new === 'goal') setDialog({ kind: 'goal' });
    else if (query.new === 'item') setDialog({ kind: 'item' });
    else return;
    setQuery({ new: '' });
  }, [query.new]);

  const newGoal = useCallback((prefill) => setDialog({ kind: 'goal', prefill }), []);
  const newItem = useCallback((prefill) => setDialog({ kind: 'item', prefill }), []);
  const palette = useCallback(() => setDialog({ kind: 'palette' }), []);

  useEffect(() => {
    const on = (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName) || e.target?.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); palette(); }
      else if (!typing && !dialog && e.key === 'c') { e.preventDefault(); newItem(); }
      else if (!typing && !dialog && e.key === 'g') { e.preventDefault(); newGoal(); }
      else if (!typing && !dialog && e.key === '/') { e.preventDefault(); palette(); }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [dialog, newGoal, newItem, palette]);

  const ctx = useMemo(() => ({ newGoal, newItem, palette, attention }), [newGoal, newItem, palette, attention]);
  const actions = [
    { label: 'New goal', icon: 'goal', run: () => newGoal() },
    { label: 'New board item', icon: 'plus', run: () => newItem() },
    { label: theme === 'light' ? 'Dark theme' : 'Light theme', icon: theme === 'light' ? 'moon' : 'sun', run: () => setTheme(theme === 'light' ? 'dark' : 'light') },
  ];
  const firstAttention = attention.goals[0];

  return (
    <AppCtx.Provider value={ctx}>
      <div className="shell">
        <nav className={`sidebar ${navOpen ? 'open' : ''}`} aria-label="Views">
          <div className="brand"><span className="logo"><Icon name="sparkles" size={15} /></span>alfred<small>gx10</small></div>
          {NAV.map((n, i) => n === null ? <div key={i} className="nav-sep" /> : (
            <a key={n[0]} href={href(n[0])} className={`nav-item ${activeFor(n[0], parts) ? 'active' : ''}`}>
              <Icon name={n[2]} size={16} />
              {n[1]}
              {n[0] === '/inbox' && attention.total > 0 && <span className="count alert" data-testid="inbox-count">{attention.total}</span>}
            </a>
          ))}
          <div className="foot">
            <div className="row between">
              <span className="conn"><span className={`dot ${live}`} /> {live === 'open' ? 'live' : live}</span>
              <button className="btn ghost sm icon" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')} aria-label="Toggle theme" title="Toggle theme">
                <Icon name={theme === 'light' ? 'moon' : 'sun'} size={14} />
              </button>
            </div>
            <div className="xs faint"><span className="kbd">⌘K</span> search · <span className="kbd">c</span> new item · <span className="kbd">g</span> new goal</div>
          </div>
        </nav>
        <div className="main">
          <header className="topbar">
            <Button variant="ghost" icon="menu" className="show-mobile" aria-label="Menu" onClick={() => setNavOpen((o) => !o)} />
            <button className="search" onClick={palette} aria-label="Search">
              <Icon name="search" size={15} /><span className="label">Search or jump to…</span><span className="grow" /><span className="kbd hide-mobile">⌘K</span>
            </button>
            <span className="spacer" />
            <span className="conn hide-mobile" title={`event stream: ${live}`}><span className={`dot ${live}`} /></span>
            <Button icon="plus" onClick={() => newItem()} aria-label="New item" className="hide-mobile">Item</Button>
            <Button variant="primary" icon="goal" onClick={() => newGoal()}>New goal</Button>
          </header>
          {attention.goals.length > 0 && (
            <div className="alert-banner" data-testid="alert-banner" role="alert">
              <Icon name="alert" size={15} />
              {attention.goals.length} goal{attention.goals.length > 1 ? 's' : ''} need attention —
              <a href={href(`/goal/${firstAttention.id}`)}>{firstAttention.title}</a>
            </div>
          )}
          <main className="content">{pick(parts)}</main>
        </div>
        <nav className="tabbar" aria-label="Tabs">
          {TABS.map(([p, label, icon]) => (
            <a key={p} href={href(p)} className={activeFor(p, parts) ? 'active' : ''}>
              <Icon name={icon} size={20} />{label}
              {p === '/inbox' && attention.total > 0 && <span className="badge-dot" />}
            </a>
          ))}
        </nav>
      </div>
      {dialog?.kind === 'goal' && <NewGoalDialog prefill={dialog.prefill} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'item' && <NewItemDialog prefill={dialog.prefill} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'palette' && <CommandPalette actions={actions} onClose={() => setDialog(null)} />}
    </AppCtx.Provider>
  );
}

export default function App() {
  return (
    <LiveProvider>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </LiveProvider>
  );
}

export { go };
