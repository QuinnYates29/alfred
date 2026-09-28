'use strict';
// P18 §5 — event → notification decisions (pure `decide`) + showing them (Electron Notification,
// or one JSON line per notification in <configDir>/notifications.log under ALFRED_APP_TEST=1).
const fs = require('node:fs');
const path = require('node:path');

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const FAILURE_TITLES = { failed: 'Failed', stopped: 'Stopped', blocked: 'Blocked' };

/**
 * @param ev  a store event {id, goalId, taskId, ts, kind, data}
 * @param ctx {settings, goalTitle(id), taskTitle(id), windowFocused}
 * @returns null | {title, body, url, actions?, approvalId?, kind}
 */
function decide(ev, ctx) {
  if (!ev || typeof ev !== 'object') return null;
  const n = (ctx && ctx.settings && ctx.settings.notify) || {};
  const data = ev.data || {};
  const goalTitle = () => (ev.goalId && ctx.goalTitle ? ctx.goalTitle(ev.goalId) : null) || ev.goalId || 'goal';
  const taskTitle = () => (ev.taskId && ctx.taskTitle ? ctx.taskTitle(ev.taskId) : null) || goalTitle();
  const out = (o) => ({ ...o, title: clip(o.title, 200), body: clip(o.body, o.kind === 'chat' ? 180 : 200) });

  switch (ev.kind) {
    case 'transition': {
      if (FAILURE_TITLES[data.to]) {
        if (!n.failures) return null;
        return out({ kind: 'failure', title: `${FAILURE_TITLES[data.to]}: ${taskTitle()}`, body: data.reason || '', url: `/goal/${ev.goalId}` });
      }
      if (data.to === 'needs_claude') {
        if (!n.failures) return null;
        return out({ kind: 'attention', title: `Needs Claude: ${taskTitle()}`, body: data.reason || '', url: `/goal/${ev.goalId}` });
      }
      return null;
    }
    case 'approval_requested': {
      if (!n.approvals || !data.approvalId) return null;
      return out({
        kind: 'approval',
        title: `Approval needed: ${data.action || 'action'}`,
        body: data.detail || '',
        url: '/inbox',
        actions: ['Approve', 'Deny'],
        approvalId: String(data.approvalId),
      });
    }
    case 'goal_status': {
      if (data.status === 'done' && n.done) return out({ kind: 'done', title: `Done: ${goalTitle()}`, body: '', url: `/goal/${ev.goalId}` });
      if (data.status === 'failed' && n.failures) {
        return out({ kind: 'failure', title: `Goal failed: ${goalTitle()}`, body: 'not every task finished done', url: `/goal/${ev.goalId}` });
      }
      return null;
    }
    case 'chat_message': {
      const m = data.message || {};
      if (m.role !== 'assistant' || !n.chat || ctx.windowFocused) return null;
      return out({ kind: 'chat', title: 'alfred', body: m.content || '', url: `/chat/${data.threadId}` });
    }
    default:
      return null;
  }
}

/**
 * Shows decided notifications. onClick(url) opens the main window at the route; onAction(approvalId, 'Approve'|'Deny').
 * In test mode nothing is shown; each notification is appended to <dir>/notifications.log.
 */
function createNotifier({ testMode, dir, onClick, onAction }) {
  const live = new Set(); // keep references: a GC'd Notification loses its click/action handlers
  function show(d) {
    if (testMode) {
      fs.appendFileSync(path.join(dir, 'notifications.log'), JSON.stringify(d) + '\n');
      return;
    }
    const { Notification } = require('electron');
    if (!Notification.isSupported()) return;
    const nt = new Notification({
      title: d.title,
      body: d.body,
      silent: d.kind === 'chat' || d.kind === 'done',
      actions: (d.actions || []).map((text) => ({ type: 'button', text })),
    });
    live.add(nt);
    const drop = () => live.delete(nt);
    nt.on('click', () => {
      drop();
      onClick(d.url);
    });
    nt.on('action', (_e, index) => {
      drop();
      const a = d.actions && d.actions[index];
      if (a && d.approvalId) onAction(d.approvalId, a);
    });
    nt.on('close', drop);
    nt.show();
    setTimeout(drop, 10 * 60_000).unref?.();
  }
  return { show };
}

module.exports = { decide, createNotifier, clip };
