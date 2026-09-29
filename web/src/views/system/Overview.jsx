// Overview: host / GPU / Qwen / tokens, refreshed every 5 s.
import { useState } from 'react';
import { useResource } from '../../lib/live.jsx';
import { compact, duration } from '../../lib/format.js';
import { Stat, Meter, Sparkline, Empty, StatusChip, Button, useToast } from '../../ui/index.jsx';
import { apiText, post } from '../../api.js';

/** H1 — the chat dataset card: turns recorded, 👍/👎, per model, and JSONL exports. */
function downloadText(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function ChatData() {
  const { data: d } = useResource('/api/chat/dataset/stats', { interval: 30000 });
  const exportKind = async (kind) => {
    try {
      downloadText(`${kind}.jsonl`, await apiText(`/api/v1/chat/dataset/export?kind=${kind}`));
    } catch {
      /* the link just does nothing if the server refuses */
    }
  };
  if (!d) return <span className="faint small">loading chat data…</span>;
  const models = Object.entries(d.byModel ?? {});
  return (
    <Panel
      title="Chat data"
      actions={(
        <span className="row">
          {['chat', 'feedback', 'goals'].map((k) => (
            <button key={k} type="button" className="btn ghost sm" onClick={() => void exportKind(k)}>Export {k}</button>
          ))}
        </span>
      )}
    >
      <div className="row wrap">
        <span className="chip info">{compact(d.turns)} turns</span>
        <span className="chip ok">👍 {d.feedback?.up ?? 0}</span>
        <span className="chip bad">👎 {d.feedback?.down ?? 0}</span>
        <span className="chip">{compact(d.bytes)} B on disk</span>
      </div>
      {models.length > 0 && (
        <table className="table">
          <thead><tr><th>Model</th><th>Turns</th><th>👍 rate</th><th>Avg latency</th></tr></thead>
          <tbody>
            {models.map(([name, m]) => (
              <tr key={name}>
                <td>{name}</td>
                <td className="key">{m.turns}</td>
                <td>{m.up + m.down ? `${Math.round((m.up / (m.up + m.down)) * 100)}% (${m.up}/${m.up + m.down})` : '—'}</td>
                <td>{duration(m.avgLatencyMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {d.dir && <span className="faint small" style={{ wordBreak: 'break-all' }}>dir: {d.dir}</span>}
    </Panel>
  );
}

/** J2 §6 — Jev, the fast decision layer: status, today's usage, and a Test button. */
function JevCard() {
  const { data: j } = useResource('/api/jev/status', { interval: 15000 });
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const test = async () => {
    setBusy(true);
    try {
      const r = await post('/api/jev/test', {});
      toast(r?.ok ? `Jev answered noul ${r.noul ?? '?'} in ${r.ms} ms` : `Jev test failed: ${r?.error ?? 'unknown'}`, r?.ok ? 'ok' : 'bad');
    } catch (e) {
      toast(`Jev test failed: ${e?.message ?? String(e)}`, 'bad');
    } finally {
      setBusy(false);
    }
  };
  if (!j) return <span className="faint small">loading Jev…</span>;
  if (!j.configured) {
    return (
      <Panel title="Jev" actions={<Button size="sm" onClick={test} disabled={busy}>Test</Button>}>
        <span className="faint small">Add TYPESAFE_API_KEY to ~/.config/alfred.env</span>
      </Panel>
    );
  }
  const t = j.today ?? {};
  const uses = Object.entries(t.byUse ?? {});
  return (
    <Panel title="Jev" actions={<Button size="sm" onClick={test} disabled={busy}>Test</Button>}>
      <div className="row wrap">
        <span className={`chip ${j.enabled ? 'ok' : 'warn'}`}>{j.enabled ? 'enabled' : 'disabled'}</span>
        <span className="chip">{j.model}</span>
        <span className="chip info">{t.calls ?? 0} calls today</span>
        <span className="chip">{compact(t.inTokens ?? 0)} tokens</span>
        <span className="chip">≈ ${Number(t.estUsd ?? 0).toFixed(4)}</span>
        <span className="chip">avg {t.avgMs ?? 0} ms</span>
      </div>
      {uses.length > 0 && (
        <table className="table">
          <thead><tr><th>Use</th><th>Calls</th><th>Tokens</th><th>Avg ms</th></tr></thead>
          <tbody>
            {uses.map(([use, u]) => (
              <tr key={use}><td>{use}</td><td className="key">{u.calls}</td><td className="key">{compact(u.inTokens + u.outTokens)}</td><td>{u.avgMs}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function Panel({ title, actions, children }) {  return (
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

        <ChatData />
        <JevCard />
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
