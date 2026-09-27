// Logs: service + line count + auto-refresh (3 s), .codeblock scrolled to bottom, text filter.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useResource } from '../../lib/live.jsx';
import { Empty } from '../../ui/index.jsx';

const SERVICES = [['alfred', 'alfred'], ['qwen-server', 'qwen-server']];
const LINE_COUNTS = [100, 200, 500, 1000, 2000];

export default function Logs() {
  const [svc, setSvc] = useState('alfred');
  const [lines, setLines] = useState(200);
  const [auto, setAuto] = useState(true);
  const [filter, setFilter] = useState('');
  const box = useRef(null);

  const { data, error, loading } = useResource(`/api/ops/logs/${svc}?lines=${lines}`, { interval: auto ? 3000 : null });
  const shown = useMemo(() => {
    const ls = data?.lines ?? [];
    return filter ? ls.filter((l) => l.toLowerCase().includes(filter.toLowerCase())) : ls;
  }, [data, filter]);

  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown]);

  return (
    <div className="card">
      <div className="card-head">
        <label className="row" style={{ gap: 6 }}>
          <span className="faint small">Service</span>
          <select className="select" style={{ width: 'auto' }} value={svc} onChange={(e) => setSvc(e.target.value)}>
            {SERVICES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="row" style={{ gap: 6 }}>
          <span className="faint small">Lines</span>
          <select className="select" style={{ width: 'auto' }} value={lines} onChange={(e) => setLines(Number(e.target.value))}>
            {LINE_COUNTS.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> auto (3 s)</label>
        <span className="actions">
          <input className="input" style={{ width: 180 }} placeholder="filter…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter logs" />
        </span>
      </div>
      <div className="card-body">
        {error
          ? <Empty icon="alert" title="Could not read logs">{error.message}</Empty>
          : loading && !data
            ? <div className="muted small">loading…</div>
            : (
              <pre ref={box} className="codeblock sys-log wrap" style={{ maxHeight: '62vh' }}>
                {shown.length ? shown.join('\n') : filter ? 'no matching lines' : '(empty)'}
              </pre>
            )}
      </div>
    </div>
  );
}
