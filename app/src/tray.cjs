'use strict';
// P18 §6 — the menu-bar tray: a pure template builder from a state object + a thin Tray wrapper.
const path = require('node:path');

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** State from the API responses: goals (GET /goals summaries), pending approvals, stats (or null). */
function computeState({ goals, approvals, stats, live, paused, node, update }) {
  let running = 0;
  let parked = 0;
  const attentionGoals = [];
  for (const g of goals || []) {
    const c = g.counts || {};
    running += (c.running || 0) + (c.verifying || 0);
    const p = (c.blocked || 0) + (c.needs_claude || 0);
    parked += p;
    if (g.status === 'failed' || p > 0) attentionGoals.push({ id: g.id, title: g.title, status: g.status === 'failed' ? 'failed' : 'parked' });
  }
  const aps = (approvals || []).map((a) => ({ id: a.id, action: a.action, detail: a.detail }));
  return {
    live: Boolean(live),
    running,
    parked,
    attention: aps.length + attentionGoals.length,
    stats: stats || null,
    approvals: aps,
    attentionGoals,
    paused: Boolean(paused),
    node: node || null,
    update: update || null,
  };
}

/**
 * Pure: the Electron menu template for `state`. `act` (optional) supplies the click handlers:
 * { open(route?), quickAdd(), newGoal(), decide(id, 'approved'|'denied'), togglePause(), settings(), installCli(), installUpdate(), quit() }.
 * Returns plain objects ({label, enabled?, type?, submenu?, click?, accelerator?, checked?}).
 */
function buildMenu(state, act = {}) {
  const s = state || {};
  const on = (fn, ...args) => (typeof fn === 'function' ? { click: () => fn(...args) } : {});
  const items = [];

  items.push({ label: s.live ? `● Live · ${s.running || 0} running · ${s.parked || 0} parked` : '○ Offline', enabled: false });
  if (s.stats) {
    const gpu = s.stats.gpu && Number.isFinite(s.stats.gpu.utilPct) ? `GPU ${Math.round(s.stats.gpu.utilPct)}%` : null;
    const q = s.stats.qwen;
    const qwen = q ? (q.ok ? `Qwen ${q.busy ?? 0}/${q.total ?? 0}` : 'Qwen offline') : null;
    const line = [gpu, qwen].filter(Boolean).join(' · ');
    if (line) items.push({ label: line, enabled: false });
  }
  if (s.node) items.push({ label: `Node: ${s.node.name} ${s.node.running ? 'running' : 'stopped'}`, enabled: false });
  if (s.update) items.push({ label: `Update available — install (${clip(s.update.version, 20)})`, ...on(act.installUpdate) });
  items.push({ type: 'separator' });

  items.push({ label: 'Open Alfred', accelerator: 'CommandOrControl+O', ...on(act.open) });
  items.push({ label: 'Quick add…', ...on(act.quickAdd) });
  items.push({ label: 'New goal…', ...on(act.newGoal) });
  const approvals = s.approvals || [];
  items.push({ label: `Inbox (${approvals.length})`, ...on(act.open, '/inbox') });

  if (approvals.length) {
    items.push({
      label: 'Approvals',
      submenu: approvals.map((a) => ({
        label: `${clip(a.action, 40)}: ${clip(a.detail, 50)}`,
        submenu: [
          { label: 'Approve', ...on(act.decide, a.id, 'approved') },
          { label: 'Deny', ...on(act.decide, a.id, 'denied') },
        ],
      })),
    });
  }
  const att = s.attentionGoals || [];
  if (att.length) {
    items.push({
      label: 'Needs attention',
      submenu: att.map((g) => ({ label: `${g.status === 'failed' ? '✕' : '⏸'} ${clip(g.title, 60)}`, ...on(act.open, `/goal/${g.id}`) })),
    });
  }

  items.push({ type: 'separator' });
  items.push({ label: 'Pause notifications', type: 'checkbox', checked: Boolean(s.paused), ...on(act.togglePause) });
  items.push({ label: 'Settings…', ...on(act.settings) });
  items.push({ label: 'Install command-line tool…', ...on(act.installCli) });
  items.push({ label: 'Quit Alfred', accelerator: 'CommandOrControl+Q', ...on(act.quit) });
  return items;
}

/** Menu-bar text next to the icon: attention count, `!` when offline, else empty. */
function titleFor(state) {
  if (!state.live) return '!';
  return state.attention > 0 ? String(state.attention) : '';
}

/** Thin wrapper around Electron's Tray (only used inside Electron). */
function createTray({ onOpen } = {}) {
  const { Tray, Menu, nativeImage } = require('electron');
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'trayTemplate.png'));
  img.setTemplateImage(true);
  const tray = new Tray(img);
  tray.setToolTip('Alfred');
  if (process.platform !== 'darwin' && onOpen) tray.on('click', () => onOpen());
  return {
    update(state, act) {
      tray.setContextMenu(Menu.buildFromTemplate(buildMenu(state, act)));
      if (process.platform === 'darwin') tray.setTitle(titleFor(state));
      tray.setToolTip(state.live ? 'Alfred' : 'Alfred — offline');
    },
    destroy() {
      tray.destroy();
    },
  };
}

module.exports = { buildMenu, computeState, titleFor, createTray };
