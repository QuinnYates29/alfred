import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { useEvents } from './sse.js';
import { useHashRoute, goalNeedsAttention } from './shared.jsx';
import GoalsView from './views/Goals.jsx';
import GoalDetail from './views/GoalDetail.jsx';
import ApprovalsView from './views/Approvals.jsx';
import AutomationsView from './views/Automations.jsx';
import PersonasView from './views/Personas.jsx';
import ModelsView from './views/Models.jsx';
import NodesView from './views/Nodes.jsx';
import DeckView from './views/Deck.jsx';

const TABS = [
  ['/', 'Goals'],
  ['#/approvals', 'Approvals'],
  ['#/automations', 'Automations'],
  ['#/personas', 'Personas'],
  ['#/models', 'Models'],
  ['#/nodes', 'Nodes'],
  ['#/deck', 'Deck'],
];

export default function App() {
  const route = useHashRoute();
  const [goals, setGoals] = useState([]);
  const [health, setHealth] = useState(null);
  const [dataTick, setDataTick] = useState(0);
  const pendingRef = useRef(new Set());
  const debounceRef = useRef(null);

  const reload = useCallback(() => {
    api('/api/goals').then(setGoals).catch(() => {});
    api('/api/health').then(setHealth).catch(() => {});
  }, []);

  useEffect(() => {
    reload();
    const t = setInterval(reload, 10_000);
    return () => clearInterval(t);
  }, [reload]);

  // One SSE stream: on any event, bump dataTick so views refetch what they show.
  const conn = useEvents((ev) => {
    pendingRef.current.add(ev?.goalId ?? '?');
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      pendingRef.current.clear();
      setDataTick((t) => t + 1);
      reload();
    }, 120);
  });

  useEffect(() => {
    setDataTick((t) => t + 1);
  }, []);

  const attention = goals.filter(goalNeedsAttention);
  const running = health?.running?.length ?? 0;

  let view = <GoalsView goals={goals} tick={dataTick} />;
  if (route.startsWith('/goal/')) view = <GoalDetail id={decodeURIComponent(route.slice(6))} tick={dataTick} />;
  else if (route.startsWith('/approvals')) view = <ApprovalsView tick={dataTick} />;
  else if (route.startsWith('/automations')) view = <AutomationsView tick={dataTick} />;
  else if (route.startsWith('/personas')) view = <PersonasView tick={dataTick} />;
  else if (route.startsWith('/models')) view = <ModelsView tick={dataTick} />;
  else if (route.startsWith('/nodes')) view = <NodesView tick={dataTick} />;
  else if (route.startsWith('/deck')) view = <DeckView health={health} tick={dataTick} />;

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">alfred</span>
        <nav className="nav" aria-label="Views">
          {TABS.map(([href, label]) => (
            <a key={href} href={href} className={(href === '#/' ? route === '/' : route.startsWith(href.slice(1))) ? 'active' : ''}>
              {label}
            </a>
          ))}
        </nav>
        <div className="hdr-meta">
          <span className={`dot ${conn === 'open' ? 'on' : conn === 'down' ? 'off' : ''}`} title={`events: ${conn}`} aria-label={`event stream ${conn}`} />
          <span>{running} running</span>
        </div>
      </header>

      {attention.length > 0 && (
        <div className="alert-banner" data-testid="alert-banner" role="alert">
          ⚠ {attention.length} goal{attention.length > 1 ? 's' : ''} need attention —{' '}
          <a href={`#/goal/${attention[0].goal.id}`}>{attention[0].goal.title}</a>
        </div>
      )}

      <main>{view}</main>
    </div>
  );
}
