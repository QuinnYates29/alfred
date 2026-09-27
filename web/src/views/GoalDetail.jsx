// #/goal/<id>[/<tab>] — goal header (status, meta, actions) + Overview / Transcript / Changes / Files.
import { useCallback, useMemo, useState } from 'react';
import { useResource } from '../lib/live.jsx';
import { href } from '../lib/router.js';
import { dateTime, duration } from '../lib/format.js';
import { post } from '../api.js';
import { Button, Icon, StatusChip, Tabs, Empty, Spinner, Field, Modal, useToast, useAction } from '../ui/index.jsx';
import { rootTask, stoppable } from './goal/model.js';
import OverviewTab from './goal/OverviewTab.jsx';
import TranscriptTab from './goal/TranscriptTab.jsx';
import ChangesTab from './goal/ChangesTab.jsx';
import FilesTab from './goal/FilesTab.jsx';
import './GoalDetail.css';

const TABS = [['', 'Overview'], ['transcript', 'Transcript'], ['changes', 'Changes'], ['files', 'Files']];

export default function GoalDetail({ id, tab = '' }) {
  const live = useCallback((ev) => ev.goalId === id, [id]);
  const { data, error, loading } = useResource(id ? `/api/goals/${id}` : null, { on: live });
  const { toast } = useToast();
  const act = useAction();
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');

  const goal = data?.goal;
  const tasks = useMemo(() => data?.tasks ?? [], [data]);
  const root = useMemo(() => rootTask(tasks), [tasks]);

  if (error) {
    return (
      <div className="page">
        <Empty icon="alert" title={error.status === 404 ? 'Goal not found' : `Could not load the goal: ${error.message}`} />
      </div>
    );
  }
  if (!goal) {
    return (
      <div className="page">
        <div className="row"><Spinner /> <span className="muted">Loading goal…</span></div>
      </div>
    );
  }

  const stoppableTasks = tasks.filter(stoppable);
  const retryRoot = root && ['failed', 'stopped'].includes(root.status);
  const itemKey = typeof goal.meta?.item === 'string' ? goal.meta.item : null;

  const stopAll = () =>
    act(async () => {
      await Promise.all(stoppableTasks.map((t) => post(`/api/tasks/${t.id}/stop`, { reason: 'stopped from the dashboard' })));
      toast('Stop requested', 'ok');
    }, null);

  const retryRootTask = () =>
    act(async () => {
      await post(`/api/tasks/${root.id}/retry`, {});
      toast('Retry queued', 'ok');
    }, null);

  const saveNote = () =>
    act(async () => {
      if (!root) throw new Error('no task to note');
      await post(`/api/tasks/${root.id}/note`, { text: note });
      toast('Note added', 'ok');
      setNoteOpen(false);
      setNote('');
    }, null);

  return (
    <div className="page">
      <div className="page-head" style={{ alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <div className="row wrap" style={{ gap: 10 }}>
            <h1 style={{ lineHeight: 1.25 }}>{goal.title}</h1>
            <StatusChip status={goal.status} />
          </div>
          <div className="sub row wrap" style={{ gap: 8, marginTop: 4 }}>
            <span className="key">{goal.slug}</span>
            <span aria-hidden="true">·</span>
            <span title="created">{dateTime(goal.createdAt)}</span>
            <span aria-hidden="true">·</span>
            <span title="elapsed">{duration((goal.status === 'active' ? Date.now() : goal.updatedAt) - goal.createdAt)}</span>
            {goal.meta?.repo ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="row" style={{ gap: 4 }} title="repo"><Icon name="git" size={13} /><span className="mono ellipsis">{String(goal.meta.repo)}</span></span>
              </>
            ) : null}
            {goal.meta?.node ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="row" style={{ gap: 4 }} title="node"><Icon name="node" size={13} />{String(goal.meta.node)}</span>
              </>
            ) : null}
            {itemKey ? (
              <>
                <span aria-hidden="true">·</span>
                <a className="row" style={{ gap: 4 }} href={href(`/board/${itemKey}`)}><Icon name="board" size={13} />{itemKey}</a>
              </>
            ) : null}
          </div>
        </div>
        <div className="actions">
          {stoppableTasks.length > 0 && (
            <Button icon="stop" onClick={stopAll} title={`Stop ${stoppableTasks.length} running/queued task${stoppableTasks.length === 1 ? '' : 's'}`}>
              Stop
            </Button>
          )}
          {retryRoot && <Button icon="retry" onClick={retryRootTask}>Retry</Button>}
          {root && (
            <Button icon="comment" variant="ghost" onClick={() => setNoteOpen(true)}>Add note</Button>
          )}
        </div>
      </div>

      <Tabs tabs={TABS} value={tab ?? ''} hrefFor={(t) => `#/goal/${id}${t ? `/${t}` : ''}`} />

      {tab === 'transcript' ? (
        <TranscriptTab goal={goal} tasks={tasks} />
      ) : tab === 'changes' ? (
        <ChangesTab id={id} />
      ) : tab === 'files' ? (
        <FilesTab id={id} tasks={tasks} />
      ) : (
        <OverviewTab goal={goal} tasks={tasks} events={data.events ?? []} usage={data.usage} />
      )}

      {noteOpen && (
        <Modal
          title="Add note"
          onClose={() => setNoteOpen(false)}
          footer={<><Button onClick={() => setNoteOpen(false)}>Cancel</Button><Button variant="primary" onClick={saveNote}>Save</Button></>}
        >
          <Field label="Note" htmlFor="goal-note">
            <textarea id="goal-note" className="textarea" autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="What should the agent know?" />
          </Field>
        </Modal>
      )}
    </div>
  );
}
