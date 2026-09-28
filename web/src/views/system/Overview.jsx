// Overview: host / GPU / Qwen / tokens, refreshed every 5 s.
import { useResource } from '../../lib/live.jsx';
import { compact, duration } from '../../lib/format.js';
import { Stat, Meter, Sparkline, Empty, StatusChip } from '../../ui/index.jsx';

function Panel({ title, actions, children }) {
  return (
    <div className="card">
      <div className="card-head"><h3>{title}</h3>{actions && <span className="actions">{actions}</span>}</div>
      <div className="card-body stack">{children}</div>
    </div>
  );
}

function BarMeter({ label, used, total, unit }) {
  const pct = total ? Math.min(100, (used / total) * 100) : 0;
  return (
    <div className="sys-meters">
      <div className="lbl"><span>{label}</span><span>{used.toFixed ? used.toFixed(1) : used}{unit} / {total.toFixed ? total.toFixed(1) : total}{unit} · {Math.round(pct)}%</span></div>
      <Meter value={pct} />
    </div>
  );
}

export default function Overview() {
  const { data: s, error } = useResource('/api/stats', { interval: 5000 });
  const { data: hist } = useResource('/api/stats/history?hours=24&bucket=3600', { interval: 30000 });

  if (error) return <Empty icon="alert" title="Stats unavailable">{error.message}</Empty>;
  if (!s) return <div className="card pad muted">Loading stats…</div>;

  const g = s.gpu;
  const q = s.qwen ?? {};
  const tokens = (hist ?? []).map((b) => b.completion);

  return (
    <div className="stack">
      <div className="grid cols-4">
        <Stat k="GPU" v={g ? `${g.utilPct}%` : 'n/a'} d={g ? `${g.name} · ${g.tempC}°C · ${g.powerW} W` : 'no gpu'}>
          {g && <Meter value={g.utilPct} />}
        </Stat>
        <Stat k="Qwen slots" v={q.ok ? `${q.busy}/${q.total}` : 'down'} d={q.ok ? 'model server' : String(q.error ?? '').slice(0, 40)} />
        <Stat k="Tokens 1h" v={compact(s.tokens.last1h.completion)} d={`${compact(s.tokens.last1h.prompt)} in · ${s.tokens.last1h.turns} turns`} />
        <Stat k="Tokens 24h" v={compact(s.tokens.last24h.completion)} d={`${compact(s.tokens.last24h.prompt)} in · ${s.tokens.last24h.turns} turns`} />
      </div>

      <div className="grid cols-2">
        <Panel title={`Host — ${s.host.hostname}`}>
          <div className="row wrap">
            <span className="chip info">load {s.host.load.map((n) => n.toFixed(2)).join(' / ')}</span>
            <span className="chip">{s.host.cpus} cpus</span>
            <span className="chip">up {duration(s.host.uptimeS * 1000)}</span>
          </div>
          <BarMeter label="Memory" used={Math.round(s.host.mem.usedMb / 102.4) / 10} total={Math.round(s.host.mem.totalMb / 102.4) / 10} unit="GB" />
          {s.host.disk
            ? <BarMeter label="Disk /" used={s.host.disk.usedGb} total={s.host.disk.totalGb} unit="GB" />
            : <span className="faint small">disk stats unavailable</span>}
        </Panel>

        <Panel title="GPU">
          {g ? (
            <>
              <div className="row wrap">
                <strong>{g.name}</strong>
                <span className="chip info">{g.utilPct}% util</span>
                <span className="chip">{g.smMhz} MHz</span>
                <span className="chip">{g.tempC}°C</span>
                <span className="chip">{g.powerW} W</span>
                {g.memUsedMb != null && <span className="chip">{compact(g.memUsedMb)} MB vram</span>}
              </div>
              <BarMeter label="Utilisation" used={g.utilPct} total={100} unit="%" />
            </>
          ) : <Empty icon="alert" title="No GPU visible (nvidia-smi failed)" />}
        </Panel>

        <Panel title="Qwen server" actions={<StatusChip status={q.ok ? 'ok' : 'bad'}>{q.ok ? 'healthy' : 'down'}</StatusChip>}>
          {q.ok ? (
            <>
              <div className="row wrap">
                <span className="key">{q.url}</span>
                <span className="chip">{q.busy} busy / {q.total}</span>
              </div>
              <div className="row wrap">
                {(q.slots ?? []).map((sl) => (
                  <span key={sl.id} className="sys-slot" title={`ctx ${sl.nCtx}`}>
                    <span className={`dot ${sl.processing ? 'busy' : ''}`} />
                    #{sl.id} {sl.processing ? 'processing' : 'idle'} · {compact(sl.promptTokens)} tok
                  </span>
                ))}
              </div>
            </>
          ) : <span className="err small">{String(q.error ?? 'unreachable')}</span>}
        </Panel>

        <Panel title="Tasks & goals">
          <div className="row wrap">
            <span className="chip running">{s.tasks.running} running</span>
            <span className="chip queued">{s.tasks.queued} queued</span>
            <span className="chip warn">{s.tasks.parked} parked</span>
            <span className="chip done">{s.tasks.done24h} done 24h</span>
            <span className="chip bad">{s.tasks.failed24h} failed 24h</span>
            <span className="chip info">{s.goals.active} active goals</span>
          </div>
        </Panel>
      </div>

      <Panel title="Completion tokens — 24 h">
        <Sparkline values={tokens} height={64} />
        <table className="table">
          <thead><tr><th>Persona</th><th>Prompt 24h</th><th>Completion 24h</th></tr></thead>
          <tbody>
            {Object.entries(s.tokens.byPersona24h ?? {}).map(([p, v]) => (
              <tr key={p}><td>{p}</td><td className="key">{compact(v.prompt)}</td><td className="key">{compact(v.completion)}</td></tr>
            ))}
            {!Object.keys(s.tokens.byPersona24h ?? {}).length && (
              <tr><td className="faint" colSpan={3}>no turns in the last 24 h</td></tr>
            )}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
