// #/ — the daily cockpit: stats tiles, needs-you, running now, due soon, recent goals.
// No "New goal"/"Create" buttons here — the top bar owns them.
import { useResource } from '../lib/live.jsx';
import { href } from '../lib/router.js';
import { compact, duration, timeAgo } from '../lib/format.js';
import { Empty, Icon, Sparkline, Stat, StatusChip } from '../ui/index.jsx';
import { attentionRows, dueSoon, greeting, needsDetail, runningGoals, useGoalDetails } from './home/model.js';
import './Home.css';

const KIND_ICON = { approval: 'check', claude: 'bot', blocked: 'alert', 'failed-goal': 'alert', item: 'board' };
const KIND_CHIP = { approval: 'accent', claude: 'needs_claude', blocked: 'blocked', 'failed-goal': 'failed', item: 'info' };

function Tiles({ stats, history }) {
  const gpu = stats?.gpu;
  const qwen = stats?.qwen;
  const tasks = stats?.tasks;
  const tokens = stats?.tokens?.last24h;
  const spark = (history ?? []).map((b) => b.completion);
  return (
    <div className="tiles">
      <Stat k="GPU" v={gpu ? `${gpu.utilPct}%` : '—'} d={gpu ? `${gpu.tempC}°C · ${Math.round(gpu.powerW)}W` : 'no gpu data'} />
      <Stat
        k="Qwen slots"
        v={qwen?.ok ? `${qwen.busy}/${qwen.total}` : '—'}
        d={qwen?.ok ? (qwen.busy ? 'busy' : 'idle') : qwen ? `offline: ${qwen.error}` : 'unknown'}
      />
      <Stat k="Tokens 24h" v={compact(tokens ? tokens.prompt + tokens.completion : 0)} d={`${tokens?.turns ?? 0} turns`}>
        <Sparkline values={spark} height={30} />
      </Stat>
      <Stat k="Tasks" v={`${tasks?.running ?? '—'}${tasks ? ` / ${tasks.queued}` : ''}`} d="running / queued" />
    </div>
  );
}

function NeedsYou({ rows }) {
  return (
    <div className="card">
      <div className="card-head">
        <h2>Needs you</h2>
        {rows.length > 0 && <span className="chip warn">{rows.length}</span>}
        <a className="btn ghost sm" style={{ marginLeft: 'auto' }} href={href('/inbox')}>Open inbox</a>
      </div>
      <div className="list">
        {rows.slice(0, 6).map((r) => (
          <a key={r.key} className="list-item link" href={href(r.href)}>
            <span className={`chip ${KIND_CHIP[r.kind]}`}><Icon name={KIND_ICON[r.kind]} size={12} /></span>
            <span className="grow" style={{ minWidth: 0 }}>
              <span className="ellipsis" style={{ display: 'block' }}>{r.title}</span>
              {r.sub && <span className="xs faint ellipsis" style={{ display: 'block' }}>{r.sub}</span>}
            </span>
          </a>
        ))}
        {!rows.length && <Empty icon="check" title="Nothing needs you. Inbox zero." />}
      </div>
    </div>
  );
}

function RunningNow({ rows, now }) {
  return (
    <div className="card">
      <div className="card-head"><h2>Running now</h2></div>
      <div className="list">
        {rows.map(({ goal, task }) => (
          <a key={goal.id} className="list-item link" href={href(`/goal/${goal.id}`)}>
            <StatusChip status="running" />
            <span className="grow" style={{ minWidth: 0 }}>
              <span className="ellipsis" style={{ display: 'block' }}>{goal.title}</span>
              <span className="xs faint ellipsis" style={{ display: 'block' }}>{task.persona} · {task.title}</span>
            </span>
            <span className="faint small">{duration(now - task.updatedAt)}</span>
          </a>
        ))}
        {!rows.length && <Empty icon="play" title="Nothing is running." />}
      </div>
    </div>
  );
}

function DueSoon({ rows }) {
  return (
    <div className="card">
      <div className="card-head"><h2>Due soon</h2></div>
      <div className="list">
        {rows.map(({ it, info }) => (
          <a key={it.id} className="list-item link" href={href(`/board/${it.key}`)}>
            <Icon name="calendar" size={14} className="faint" />
            <span className="grow ellipsis">{it.title}</span>
            <span className={`small ${info.overdue ? 'due-bad' : info.soon ? 'due-warn' : 'faint'}`}>{info.label}</span>
          </a>
        ))}
        {!rows.length && <Empty icon="calendar" title="Nothing due in the next 7 days." />}
      </div>
    </div>
  );
}

function Recent({ goals }) {
  return (
    <div className="card">
      <div className="card-head"><h2>Recent</h2></div>
      <div className="list">
        {goals.slice(0, 8).map((g) => (
          <a key={g.id} className="list-item link" href={href(`/goal/${g.id}`)}>
            <StatusChip status={g.status} />
            <span className="grow ellipsis">{g.title}</span>
            <span className="faint small">{timeAgo(g.createdAt)}</span>
          </a>
        ))}
        {!goals.length && <Empty icon="goal" title="No goals yet" />}
      </div>
    </div>
  );
}

export default function Home() {
  const stats = useResource('/api/stats', { interval: 10_000 });
  const history = useResource('/api/stats/history?hours=24&bucket=3600', { interval: 60_000 });
  const goalsRes = useResource('/api/goals', { on: ['goal_', 'transition', 'task_created'] });
  const approvals = useResource('/api/approvals?status=pending', { on: ['approval_'] });
  const items = useResource('/api/items?label=needs-attention', { on: ['item_'] });
  const goals = goalsRes.data ?? [];
  const detailIds = goals.filter(needsDetail).slice(0, 8).map((g) => g.id);
  const details = useGoalDetails(detailIds, { interval: 15_000 });
  const now = Date.now();

  const rows = attentionRows({ approvals: approvals.data ?? [], items: items.data ?? [], goals, details });
  const running = runningGoals(goals, details);
  const due = dueSoon(items.data ?? []);
  const recent = goals;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{greeting()}</h1>
          <div className="muted small">
            {new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
          </div>
        </div>
      </div>
      <Tiles stats={stats.data} history={history.data} />
      <div className="home-grid">
        <div className="stack">
          <NeedsYou rows={rows} />
          <RunningNow rows={running} now={now} />
        </div>
        <div className="stack">
          <DueSoon rows={due} />
          <Recent goals={recent} />
        </div>
      </div>
      {goalsRes.error && <div className="small faint">fetch failed: {goalsRes.error.message}</div>}
    </div>
  );
}
