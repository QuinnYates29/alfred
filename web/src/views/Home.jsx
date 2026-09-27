// Placeholder until P17d: the goals list, so the shell is usable. (No "New goal"/"Create" buttons here — the top bar owns them.)
import { useResource } from '../lib/live.jsx';
import { href } from '../lib/router.js';
import { timeAgo } from '../lib/format.js';
import { StatusChip, Empty } from '../ui/index.jsx';

export default function Home() {
  const { data } = useResource('/api/goals', { on: ['goal_', 'transition', 'task_created'] });
  return (
    <div className="page">
      <div className="page-head"><h1>Home</h1></div>
      <div className="card list">
        {(data ?? []).map((g) => (
          <a key={g.id} className="list-item link" href={href(`/goal/${g.id}`)}>
            <StatusChip status={g.status} />
            <span className="grow ellipsis">{g.title}</span>
            <span className="faint small">{timeAgo(g.createdAt)}</span>
          </a>
        ))}
        {data && !data.length && <Empty icon="goal" title="No goals yet" />}
      </div>
    </div>
  );
}
