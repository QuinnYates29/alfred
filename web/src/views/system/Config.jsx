// Config: edit personas/*.yaml and config/*.yaml|json with server-side validation.
// 400 → inline error; 409 → "changed elsewhere, reload?"; success toast says what reloaded.
import { useEffect, useState } from 'react';
import { useResource } from '../../lib/live.jsx';
import { setQuery } from '../../lib/router.js';
import { api } from '../../api.js';
import { dateTime } from '../../lib/format.js';
import { Button, Empty, Spinner, useToast } from '../../ui/index.jsx';

const KINDS = [['persona', 'Personas'], ['models', 'Models'], ['alfred', 'Alfred'], ['mcp', 'MCP'], ['other', 'Other']];

export default function Config({ file }) {
  const { data: files, reload: reloadFiles } = useResource('/api/ops/config');
  const path = file || null;
  const { data: loaded, loading, reload } = useResource(path ? `/api/ops/config/file?path=${encodeURIComponent(path)}` : null, { deps: [path] });
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);
  const { toast, confirm } = useToast();

  useEffect(() => {
    if (loaded) { setContent(loaded.content); setDirty(false); setErr(null); }
  }, [loaded?.path, loaded?.mtime]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!path) return;
    setSaving(true);
    setErr(null);
    try {
      const out = await api('/api/ops/config/file', { method: 'PUT', body: { path, content, mtime: loaded?.mtime, confirm: true } });
      const what = (out.reloaded ?? []).join(', ');
      toast(what ? `Saved — reloaded ${what}` : 'Saved', 'ok');
      (out.warnings ?? []).forEach((w) => toast(w, 'bad'));
      reload();
    } catch (e) {
      if (e.status === 409) {
        if (await confirm({ title: 'This file changed elsewhere', body: 'Reload the file from disk? Your edits will be lost.', ok: 'Reload' })) reload();
      } else {
        setErr(e?.message ?? String(e));
      }
    } finally {
      setSaving(false);
    }
  };

  const groups = KINDS
    .map(([kind, label]) => [label, (files ?? []).filter((f) => f.kind === kind)])
    .filter(([, list]) => list.length);

  return (
    <div className="sys-cols">
      <div className="card sys-files">
        <div className="card-head"><h3>Files</h3><span className="actions"><Button size="sm" variant="ghost" icon="retry" onClick={reloadFiles}>↻</Button></span></div>
        {groups.map(([label, list]) => (
          <div key={label}>
            <div className="group">{label}</div>
            {list.map((f) => (
              <div key={f.path} className={`list-item ${f.path === path ? 'sel' : ''}`} onClick={() => setQuery({ file: f.path })} role="button" tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && setQuery({ file: f.path })}>
                <span className="grow stack tight" style={{ minWidth: 0, gap: 2 }}>
                  <span className="mono small ellipsis" title={f.path}>{f.path}</span>
                  <span className="faint xs">{f.size < 1024 ? `${f.size} B` : `${(f.size / 1024).toFixed(1)} KB`} · {dateTime(f.mtime)}</span>
                </span>
              </div>
            ))}
          </div>
        ))}
        {files && !files.length && <Empty title="No config files" />}
      </div>

      <div className="card pad stack">
        {!path && <Empty icon="file" title="Pick a file to edit" children="personas, models, alfred.yaml — validated before writing." />}
        {path && loading && !loaded && <div className="row"><Spinner /> loading {path}…</div>}
        {path && loaded && (
          <>
            <div className="row between">
              <strong className="key">{loaded.path}</strong>
              <span className="faint xs">mtime {dateTime(loaded.mtime)}</span>
            </div>
            <textarea
              data-testid="config-editor"
              className="textarea code"
              value={content}
              spellCheck={false}
              onChange={(e) => { setContent(e.target.value); setDirty(true); }}
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); } }}
              aria-label={`Edit ${loaded.path}`}
            />
            {err && <div className="err" data-testid="config-error" role="alert">{err}</div>}
            <div className="btn-row">
              <Button variant="primary" data-testid="config-save" disabled={!dirty || saving} onClick={save}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
              {dirty && <Button variant="ghost" onClick={() => { setContent(loaded.content); setDirty(false); setErr(null); }}>Revert</Button>}
              <span className="grow" />
              <span className="faint xs">⌘/Ctrl+S saves · the server validates and backs up first</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
