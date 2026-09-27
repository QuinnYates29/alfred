// Files: browse the goal's task workspace (local fs or a node), open a file as text.
import { useMemo, useState } from 'react';
import { useResource } from '../../lib/live.jsx';
import { Empty, Icon, Spinner } from '../../ui/index.jsx';

export default function FilesTab({ id, tasks }) {
  const [taskId, setTaskId] = useState('');
  const [path, setPath] = useState('.');
  const [file, setFile] = useState('');

  const rootId = tasks.find((t) => !t.parentTaskId)?.id ?? tasks[0]?.id ?? '';
  const picked = taskId || rootId;
  const live = useMemo(() => (ev) => ev.goalId === id, [id]);
  const tq = taskId ? `&task=${encodeURIComponent(taskId)}` : '';
  const dir = useResource(`/api/goals/${id}/files?path=${encodeURIComponent(path)}${tq}`, { on: live });
  const shown = file;
  const content = useResource(shown ? `/api/goals/${id}/file?path=${encodeURIComponent(shown)}${tq}` : null, { on: live });

  const offline = (e) => e?.status === 503;
  const entries = dir.data?.entries ?? [];
  const segs = path === '.' ? [] : path.split('/');

  const openDir = (p) => { setFile(''); setPath(p); };
  const crumbs = [];
  for (let i = 0; i < segs.length; i++) crumbs.push({ label: segs[i], to: segs.slice(0, i + 1).join('/') });

  return (
    <div className="changes-grid">
      <div className="stack" style={{ gap: 'var(--s-3)' }}>
        {tasks.length > 1 && (
          <div className="field">
            <label htmlFor="files-task">Task</label>
            <select id="files-task" className="select" value={picked} onChange={(e) => setTaskId(e.target.value)}>
              {tasks.map((t) => <option key={t.id} value={t.id}>{t.persona} · {t.title}</option>)}
            </select>
          </div>
        )}
        <div className="card">
          <div className="card-head">
            <nav className="crumb" aria-label="path">
              <button type="button" onClick={() => openDir('.')}>workspace</button>
              {crumbs.map((c) => (
                <span key={c.to} className="row" style={{ gap: 4 }}>
                  <Icon name="chevronRight" size={12} />
                  <button type="button" onClick={() => openDir(c.to)}>{c.label}</button>
                </span>
              ))}
            </nav>
            {dir.loading && <Spinner size={14} />}
          </div>
          {dir.error ? (
            offline(dir.error)
              ? <Empty icon="node" title="node offline" />
              : <Empty icon="alert" title={dir.error.status === 404 ? 'No workspace yet' : dir.error.message} />
          ) : entries.length === 0 && !dir.loading ? (
            <Empty icon="folder" title="Empty directory" />
          ) : (
            entries.map((e) => (
              <button
                key={`${e.name}:${e.dir}`}
                className="entry"
                onClick={() => (e.dir ? openDir((path === '.' ? '' : `${path}/`) + e.name) : setFile((path === '.' ? '' : `${path}/`) + e.name))}
              >
                <Icon className="icon" name={e.dir ? 'folder' : 'file'} size={15} />
                <span className="grow ellipsis">{e.name}</span>
                {e.dir ? <Icon name="chevronRight" size={13} /> : null}
              </button>
            ))
          )}
        </div>
      </div>

      <div className="stack tight">
        <div className="row between">
          <span className="mono small ellipsis">{file || ''}</span>
          {content.loading && <Spinner size={14} />}
        </div>
        {!file && <Empty icon="file" title="Pick a file to read" />}
        {file && content.error && (
          offline(content.error)
            ? <Empty icon="node" title="node offline" />
            : <Empty icon="alert" title={content.error.message} />
        )}
        {file && content.data && <pre className="codeblock wrap">{content.data.content}</pre>}
        {content.data?.truncated ? <div className="xs faint">truncated at {content.data.size} bytes</div> : null}
      </div>
    </div>
  );
}
