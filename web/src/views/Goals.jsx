// #/goals — the goals list: segment filter, text filter, rows with status/where/counts/age.
import { useState } from 'react';
import { useResource } from '../lib/live.jsx';
import { href } from '../lib/router.js';
import { timeAgo } from '../lib/format.js';
import { Seg, StatusChip, Empty, Spinner } from '../ui/index.jsx';
import { GOAL_SEGS, filterGoals, needsAttention, countTasks, whereOf } from './goal/model.js';

export default function Goals() {
  const { data, loading, error } = useResource('/api/goals', { on: ['goal_', 'transition', 'task_created'] });
  const [seg, setSeg] = useState('active');
  const [text, setText] = useState('');

  const goals = filterGoals(data, seg, text);
  const totalFor = (s) => (data ?? []).filter((g) => (s === 'attention' ? needsAttention(g) : s === 'all' || g.status === s)).length;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Goals</h1>
        <span className="sub">{data ? `${data.length} total` : ''}</span>
        <div className="actions">
          <input
            className="input"
            style={{ width: 220 }}
            placeholder="Filter goals…"
            aria-label="Filter goals"
            value={text}
            onChange={(e) => setText(e.target.value)}
            data-testid="goals-filter"
          />
        </div>
      </div>
      <div>
        <Seg options={GOAL_SEGS.map(([id, label]) => [id, totalFor(id) ? `${label} ${totalFor(id)}` : label])} value={seg} onChange={setSeg} />
      </div>

      <div className="card list">
        {loading && !data && (
          <div className="row" style={{ padding: 20 }}>
            <Spinner /> <span className="muted">Loading goals…</span>
          </div>
        )}
        {error && <Empty icon="alert" title={`Could not load goals: ${error.message}`} />}
        {goals.map((g) => (
          <a key={g.id} className="list-item link" href={href(`/goal/${g.id}`)}>
            <StatusChip status={g.status} />
            <span className="grow" style={{ minWidth: 0 }}>
              <span className="ellipsis" style={{ fontWeight: 500 }}>{g.title}</span>
              <span className="xs faint ellipsis" style={{ display: 'block' }}>
                <span className="key">{g.slug}</span>
                {' · '}{whereOf(g)}
                {g.meta?.persona ? <> · {String(g.meta.persona)}</> : null}
              </span>
            </span>
            <span className="row wrap" style={{ gap: 10, justifyContent: 'flex-end' }}>
              <span className="chip" title="tasks">{countTasks(g.counts)} task{countTasks(g.counts) === 1 ? '' : 's'}</span>
              {(g.counts?.running ?? 0) > 0 && <span className="chip running"><span className="dot" />{g.counts.running} running</span>}
              <span className="xs faint" style={{ minWidth: 56, textAlign: 'right' }}>
                {g.status === 'active' ? timeAgo(g.updatedAt || g.createdAt) : timeAgo(g.createdAt)}
              </span>
            </span>
          </a>
        ))}
        {data && !goals.length && !error && (
          <Empty icon="goal" title={text || seg !== 'active' ? 'No goals match this filter' : 'No active goals'}>
            {text || seg !== 'active' ? (
              <button className="btn sm" onClick={() => { setText(''); setSeg('all'); }}>Show all</button>
            ) : null}
          </Empty>
        )}
      </div>
    </div>
  );
}
