'use strict';
// P18 — Alfred for macOS: app lifecycle, windows, tray, IPC and wiring. All compute stays on the Spark;
// this process only talks HTTP(S) to the configured server. Never log the token.
const { app, BrowserWindow, ipcMain, shell, Menu, globalShortcut, screen, dialog } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const settingsStore = require('./settings.cjs');
const { createApi } = require('./api.cjs');
const { decide, createNotifier } = require('./notify.cjs');
const { buildMenu, computeState, createTray } = require('./tray.cjs');
const { submitQuick } = require('./quick.cjs');
const { createNodeRunner, SCRIPT: NODE_SCRIPT } = require('./node.cjs');
const updater = require('./update.cjs');
const macSetup = require('./mac-setup.cjs');

const TEST = process.env.ALFRED_APP_TEST === '1';
const IS_MAC = process.platform === 'darwin';
const CONFIG_DIR = settingsStore.configDir();
// An explicit config dir also isolates Chromium's profile (tests, side-by-side installs).
if (process.env.ALFRED_APP_CONFIG_DIR) app.setPath('userData', path.join(CONFIG_DIR, 'electron'));
const PRELOAD = path.join(__dirname, 'preload.cjs');
const POLL_MS = 15_000;
const STALE_EVENT_MS = 15 * 60_000; // replayed events older than this (after a long disconnect) do not notify

let settings = settingsStore.defaults();
let mainWin = null;
let settingsWin = null;
let quickWin = null;
let tray = null;
let events = null;
let pollTimer = null;
let trayTimer = null;
let trayState = null;
let pausedUntil = 0;
let quitting = false;
let queue = Promise.resolve();
let updateTimer = null;
const BUNDLE_ID_DEFAULT = 'net.popotomodem.alfred';
/** Self-update state (U1): what we are, what the server has, whether it is newer. */
const upd = {
  current: updater.currentBuild(undefined, app.getVersion()),
  latest: null,
  available: false,
  checking: false,
  installing: false,
  lastCheck: null,
  error: null,
  status: '',
  notifiedBuild: null,
};

const api = createApi(() => settings);
const goalTitles = new Map();
const taskTitles = new Map();

// ---------------------------------------------------------------- helpers

const originOf = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
};
const isDashboard = (u) => originOf(u) !== null && originOf(u) === originOf(settings.url);
const dashboardUrl = (route = '/') => `${settings.url}/?token=${encodeURIComponent(settings.token)}#${route}`;
const isPaused = () => Date.now() < pausedUntil;

function openExternal(u) {
  try {
    const p = new URL(u).protocol;
    if (p === 'http:' || p === 'https:' || p === 'mailto:') void shell.openExternal(u);
  } catch {
    /* not a URL */
  }
}

/** IPC from the app's own pages (settings/quick, file://) or a direct main-process call (tests). */
function fromAppPage(e) {
  const url = e && e.senderFrame ? e.senderFrame.url : null;
  return !e || !e.sender || (typeof url === 'string' && url.startsWith('file://'));
}
const fromDashboard = (e) => Boolean(e && e.senderFrame && isDashboard(e.senderFrame.url));

function saveSettings(next) {
  settings = settingsStore.save(next, CONFIG_DIR);
  return settings;
}

// ---------------------------------------------------------------- windows

function createMainWindow(route = '/') {
  const b = settings.bounds;
  const onScreen = b && screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y;
  });
  mainWin = new BrowserWindow({
    width: b ? Math.max(900, b.width) : 1280,
    height: b ? Math.max(600, b.height) : 820,
    ...(onScreen ? { x: b.x, y: b.y } : {}),
    minWidth: 900,
    minHeight: 600,
    title: 'Alfred',
    backgroundColor: '#111111',
    ...(IS_MAC ? { titleBarStyle: 'hiddenInset' } : { icon: path.join(__dirname, '..', 'assets', 'icon.png') }),
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--alfred-version=${app.getVersion()}`],
    },
  });
  const wc = mainWin.webContents;

  // Only the configured dashboard origin is ever loaded in the window; everything else → default browser.
  const guard = (e, url) => {
    if (!isDashboard(url)) {
      e.preventDefault();
      openExternal(url);
    }
  };
  wc.on('will-navigate', guard);
  wc.on('will-redirect', guard);
  wc.setWindowOpenHandler(({ url }) => {
    if (isDashboard(url)) void mainWin.loadURL(url);
    else openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-attach-webview', (e) => e.preventDefault());

  if (IS_MAC) {
    // hiddenInset: leave room for the traffic lights and give the window a drag strip.
    wc.on('dom-ready', () => {
      void wc.insertCSS(
        'html{box-sizing:border-box;padding-top:28px}' +
          'html::before{content:"";position:fixed;top:0;left:0;right:0;height:28px;-webkit-app-region:drag;z-index:2147483647}',
      );
    });
  }

  let retry = null;
  wc.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = aborted by a newer navigation
    clearTimeout(retry);
    retry = setTimeout(() => mainWin && !mainWin.isDestroyed() && mainWin.loadURL(dashboardUrl()).catch(() => {}), 10_000);
  });

  let boundsTimer = null;
  const rememberBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!mainWin || mainWin.isDestroyed()) return;
      try {
        saveSettings({ ...settings, bounds: mainWin.getNormalBounds() });
      } catch {
        /* disk full etc.: bounds are a nicety */
      }
    }, 500);
  };
  mainWin.on('resize', rememberBounds);
  mainWin.on('move', rememberBounds);
  mainWin.on('close', (e) => {
    if (quitting) return;
    e.preventDefault(); // closing hides; the app keeps running in the menu bar (⌘Q quits)
    mainWin.hide();
  });
  mainWin.on('closed', () => {
    mainWin = null;
  });
  void mainWin.loadURL(dashboardUrl(route)).catch(() => {});
  return mainWin;
}

/** Show the dashboard, optionally at a hash route like `/goal/<id>`. */
function showMain(route) {
  if (!settingsStore.isConfigured(settings)) return openSettings();
  if (!mainWin || mainWin.isDestroyed()) {
    createMainWindow(route || '/');
  } else if (route) {
    const cur = mainWin.webContents.getURL();
    if (isDashboard(cur)) void mainWin.webContents.executeJavaScript(`location.hash = ${JSON.stringify('#' + route)}`).catch(() => {});
    else void mainWin.loadURL(dashboardUrl(route)).catch(() => {});
  }
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 560,
    height: 800,
    resizable: true,
    minimizable: false,
    title: 'Alfred Settings',
    backgroundColor: '#111111',
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  settingsWin.webContents.on('will-navigate', (e) => e.preventDefault());
  settingsWin.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
  void settingsWin.loadFile(path.join(__dirname, 'settings.html'));
}

function createQuickWindow() {
  quickWin = new BrowserWindow({
    width: 620,
    height: 104,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#1b1b1d',
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  quickWin.setAlwaysOnTop(true, 'floating');
  if (IS_MAC) quickWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  quickWin.webContents.on('will-navigate', (e) => e.preventDefault());
  quickWin.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      e.preventDefault();
      quickWin.hide();
    }
  });
  quickWin.on('blur', () => quickWin && !quickWin.isDestroyed() && quickWin.hide());
  quickWin.on('closed', () => {
    quickWin = null;
  });
  void quickWin.loadFile(path.join(__dirname, 'quick.html'));
}

function showQuick() {
  if (!quickWin || quickWin.isDestroyed()) createQuickWindow();
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const [w, h] = quickWin.getSize();
  quickWin.setPosition(Math.round(d.x + (d.width - w) / 2), Math.round(d.y + d.height * 0.28));
  quickWin.show();
  quickWin.focus();
}

// ---------------------------------------------------------------- event stream → notifications

const notifier = createNotifier({
  testMode: TEST,
  dir: CONFIG_DIR,
  onClick: (route) => (route === 'settings:updates' ? openSettings() : showMain(route)),
  onAction: (id, action) => void notificationAction(id, action).catch(() => {}),
});

async function notificationAction(approvalId, action) {
  const decision = action === 'Approve' ? 'approved' : action === 'Deny' ? 'denied' : null;
  if (!decision) throw new Error(`unknown action: ${action}`);
  try {
    await api.request('POST', `/api/v1/approvals/${encodeURIComponent(approvalId)}`, { decision, by: 'mac-app' });
  } catch (e) {
    if (TEST) throw e;
    notifier.show({ kind: 'error', title: `⚠ ${action} failed`, body: e?.message ?? String(e), url: '/inbox' });
  } finally {
    scheduleTray();
  }
}

/** Fill the title caches for an event's goal (one GET per unknown goal/task). */
async function ensureTitles(ev) {
  if (!ev.goalId) return;
  if (goalTitles.has(ev.goalId) && (!ev.taskId || taskTitles.has(ev.taskId))) return;
  try {
    const r = await api.request('GET', `/api/v1/goals/${encodeURIComponent(ev.goalId)}`);
    if (r?.goal) goalTitles.set(r.goal.id, r.goal.title);
    for (const t of r?.tasks ?? []) taskTitles.set(t.id, t.title);
  } catch {
    /* fall back to ids */
  }
}

const TRAY_KINDS = new Set(['transition', 'goal_status', 'goal_created', 'approval_requested', 'approval_decided']);

async function onEvent(ev) {
  if (ev.kind === 'transition' || ev.kind === 'goal_status') await ensureTitles(ev);
  const d = decide(ev, {
    settings,
    goalTitle: (id) => goalTitles.get(id),
    taskTitle: (id) => taskTitles.get(id),
    windowFocused: Boolean(mainWin && !mainWin.isDestroyed() && mainWin.isFocused()),
  });
  const stale = typeof ev.ts === 'number' && ev.ts > 0 && Date.now() - ev.ts > STALE_EVENT_MS;
  if (d && !isPaused() && !stale) {
    try {
      notifier.show(d);
    } catch (e) {
      console.error('[alfred-app] notification failed:', e?.message ?? e);
    }
  }
  if (TRAY_KINDS.has(ev.kind)) scheduleTray();
}

function startStream() {
  events?.close();
  events = null;
  if (!settingsStore.isConfigured(settings)) return;
  events = api.stream((since) => `/api/v1/events?since=${since ?? 0}`, (ev) => {
    queue = queue.then(() => onEvent(ev)).catch(() => {});
  }, {
    start: async () => Number((await api.request('GET', '/api/v1/events/last'))?.id ?? 0),
    onStatus: () => scheduleTray(),
  });
}

// ---------------------------------------------------------------- tray

const trayActions = {
  open: (route) => showMain(route),
  quickAdd: () => showQuick(),
  newGoal: () => showMain('/?new=goal'),
  decide: (id, decision) => void notificationAction(id, decision === 'approved' ? 'Approve' : 'Deny').catch(() => {}),
  togglePause: () => {
    pausedUntil = isPaused() ? 0 : Date.now() + 60 * 60_000;
    scheduleTray();
  },
  settings: () => openSettings(),
  installCli: () => void installCli(),
  installUpdate: () => void installUpdateFlow(),
  quit: () => app.quit(),
};

async function refreshTray() {
  let goals = null;
  let approvals = [];
  let stats = null;
  let live = false;
  if (settingsStore.isConfigured(settings)) {
    try {
      goals = await api.request('GET', '/api/v1/goals');
      live = true;
      for (const g of goals) goalTitles.set(g.id, g.title);
    } catch {
      /* offline */
    }
    if (live) {
      [approvals, stats] = await Promise.all([
        api.request('GET', '/api/v1/approvals?status=pending').catch(() => []),
        api.request('GET', '/api/v1/stats').catch(() => null), // older servers: 404
      ]);
    }
  }
  const update = upd.available && upd.latest ? { version: upd.latest.version, build: upd.latest.build } : null;
  trayState = computeState({ goals, approvals, stats, live, paused: isPaused(), node: nodeRunner.state(), update });
  try {
    tray?.update(trayState, trayActions);
  } catch (e) {
    console.error('[alfred-app] tray update failed:', e?.message ?? e);
  }
}

/** Debounced refresh (events arrive in bursts). */
function scheduleTray(ms = 400) {
  clearTimeout(trayTimer);
  trayTimer = setTimeout(() => void refreshTray(), ms);
}

// ---------------------------------------------------------------- node + CLI

const nodeRunner = createNodeRunner({
  logFile: path.join(CONFIG_DIR, 'node.log'),
  onState: () => scheduleTray(50),
});

async function installCli() {
  try {
    const out = macSetup.installCli({ src: path.join(__dirname, '..', 'cli', 'alfred.mjs'), url: settings.url, token: settings.token });
    await dialog.showMessageBox({
      type: 'info',
      message: `Installed ${out.bin}`,
      detail: `${out.config} now holds this app's server URL and token, so \`alfred\` needs no login. Make sure ~/.local/bin is on your PATH.`,
    });
    return { ok: true, ...out };
  } catch (e) {
    if (e?.code === 'NO_CLI') {
      await dialog.showMessageBox({
        type: 'warning',
        message: 'The command-line tool is not bundled in this build.',
        detail: 'app/cli/alfred.mjs is produced by `npm run build:cli` in the alfred repo; rebuild the app after running it.',
      });
    } else {
      await dialog.showMessageBox({ type: 'error', message: 'Could not install the command-line tool', detail: e?.message ?? String(e) });
    }
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/** Unload + disable the old LaunchAgent node and turn on the built-in one (prefilled from the agent's args). */
async function useBuiltInNode() {
  const info = macSetup.launchAgentInfo();
  if (!info) return { ok: false, error: 'no LaunchAgent installed' };
  const r = await macSetup.disableLaunchAgent();
  if (!r.ok) return r;
  const prev = settings;
  const n = prev.node;
  saveSettings({
    ...prev,
    node: {
      ...n,
      enabled: true,
      name: info.name || n.name,
      roots: n.roots.length ? n.roots : info.roots,
      dsh: n.dsh || info.dsh,
      messages: n.messages || info.messages,
    },
  });
  applySettings(prev);
  const warn = [r.warning, settings.node.roots.length ? null : 'add at least one root folder so the node can start'].filter(Boolean).join('; ');
  return { ok: true, disabled: r.disabled, ...(warn ? { warning: warn } : {}) };
}

// ---------------------------------------------------------------- self-update (U1)

function updateView() {
  const exe = app.getPath('exe');
  return {
    current: upd.current,
    latest: upd.latest,
    available: upd.available,
    checking: upd.checking,
    installing: upd.installing,
    lastCheck: upd.lastCheck,
    error: upd.error,
    status: upd.status,
    supported: IS_MAC,
    packaged: app.isPackaged,
    canRollback: IS_MAC && Boolean(updater.previousBundle(exe)),
    auto: settings.updates.auto,
  };
}

async function checkForUpdates({ notify = false } = {}) {
  if (!settingsStore.isConfigured(settings)) {
    upd.error = 'connect to the server first';
    return updateView();
  }
  upd.checking = true;
  try {
    upd.latest = await api.request('GET', '/api/v1/app/latest', undefined, { timeoutMs: 15_000 });
    upd.error = null;
  } catch (e) {
    upd.latest = null;
    upd.error = e?.status === 404 ? 'no Mac build on the server yet' : e?.message ?? String(e);
  } finally {
    upd.checking = false;
    upd.lastCheck = Date.now();
  }
  upd.available = IS_MAC && updater.isNewer(upd.latest, upd.current);
  if (upd.available && notify && upd.notifiedBuild !== upd.latest.build) {
    upd.notifiedBuild = upd.latest.build;
    try {
      notifier.show({
        kind: 'update',
        title: 'Alfred update available',
        body: `${upd.latest.version} (build ${upd.latest.build}, ${upd.latest.commit}) — open Settings to install`,
        url: 'settings:updates',
      });
    } catch {
      /* notifications are a nicety */
    }
  }
  scheduleTray(50);
  return updateView();
}

function scheduleUpdateChecks() {
  clearInterval(updateTimer);
  updateTimer = null;
  if (TEST || !IS_MAC || !app.isPackaged || !settings.updates.auto) return;
  updateTimer = setInterval(() => void checkForUpdates({ notify: true }), updater.CHECK_EVERY_MS);
}

function ownBundleId() {
  try {
    const b = updater.bundlePathFrom(app.getPath('exe'));
    return (b && updater.readBundleId(b)) || BUNDLE_ID_DEFAULT;
  } catch {
    return BUNDLE_ID_DEFAULT;
  }
}

function updateDeps() {
  return {
    conf: () => ({ url: settings.url, token: settings.token }),
    exePath: app.getPath('exe'),
    bundleId: ownBundleId(),
    logFile: path.join(CONFIG_DIR, 'update.log'),
    onStatus: (t) => {
      upd.status = t;
    },
    quit: () => {
      quitting = true;
      setTimeout(() => app.quit(), 300);
    },
  };
}

async function installUpdateFlow() {
  if (!IS_MAC) return { ok: false, error: 'updates are for macOS' };
  if (upd.installing) return { ok: false, error: 'an update is already in progress' };
  await checkForUpdates();
  if (!upd.available) return { ok: false, error: upd.error || 'already up to date' };
  upd.installing = true;
  const r = await updater.installUpdate({ ...updateDeps(), latest: upd.latest });
  if (!r.ok) {
    upd.installing = false;
    upd.status = '';
    upd.error = r.error;
    if (!TEST) void dialog.showMessageBox({ type: 'error', message: 'Update failed', detail: r.error });
  }
  return r;
}

function rollbackFlow() {
  const r = updater.rollback(updateDeps());
  if (!r.ok) upd.error = r.error;
  return r;
}

// ---------------------------------------------------------------- settings side effects

let registeredShortcut = null;
function applyShortcut() {
  if (TEST) return;
  if (registeredShortcut) globalShortcut.unregister(registeredShortcut);
  registeredShortcut = null;
  try {
    if (globalShortcut.register(settings.shortcut, showQuick)) registeredShortcut = settings.shortcut;
  } catch {
    /* invalid accelerator: settings window shows it unchanged */
  }
}

function applyLoginItem() {
  if (TEST || !IS_MAC) return;
  try {
    app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin, openAsHidden: true });
  } catch {
    /* unsigned builds may refuse */
  }
}

function applySettings(prev) {
  const conn = !prev || prev.url !== settings.url || prev.token !== settings.token;
  if (conn) {
    goalTitles.clear();
    taskTitles.clear();
    startStream();
    if (settingsStore.isConfigured(settings)) {
      if (mainWin && !mainWin.isDestroyed()) void mainWin.loadURL(dashboardUrl()).catch(() => {});
      else createMainWindow();
    }
  }
  applyShortcut();
  applyLoginItem();
  nodeRunner.apply(settings);
  scheduleUpdateChecks();
  scheduleTray(50);
}

// ---------------------------------------------------------------- IPC (the contract in docs/phases/P18-mac-app.md)

function registerIpc() {
  ipcMain.handle('quick:submit', async (e, text) => {
    if (!fromAppPage(e) && !fromDashboard(e)) throw new Error('forbidden');
    const line = await submitQuick(String(text ?? ''), api);
    if (quickWin && e && e.sender === quickWin.webContents) setTimeout(() => quickWin && !quickWin.isDestroyed() && quickWin.hide(), 1200);
    scheduleTray();
    return line;
  });

  ipcMain.handle('settings:get', (e) => {
    if (!fromAppPage(e)) throw new Error('forbidden');
    const { bounds: _b, ...s } = settings;
    return {
      ...s,
      node: { ...s.node, bundled: fs.existsSync(NODE_SCRIPT) },
      nodeState: nodeRunner.state(),
      launchAgent: IS_MAC ? macSetup.launchAgentInfo() : null,
      cliBundled: fs.existsSync(path.join(__dirname, '..', 'cli', 'alfred.mjs')),
    };
  });

  ipcMain.handle('settings:save', (e, s) => {
    if (!fromAppPage(e)) throw new Error('forbidden');
    try {
      const prev = settings;
      const incoming = s && typeof s === 'object' ? s : {};
      saveSettings({
        ...prev,
        ...incoming,
        notify: { ...prev.notify, ...(incoming.notify || {}) },
        node: { ...prev.node, ...(incoming.node || {}) },
        updates: { ...prev.updates, ...(incoming.updates || {}) },
        bounds: prev.bounds,
      });
      applySettings(prev);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle('settings:test', async (e, s) => {
    if (!fromAppPage(e)) throw new Error('forbidden');
    const url = String(s?.url ?? '').trim().replace(/\/+$/, '');
    const token = String(s?.token ?? '');
    if (!url) return { ok: false, error: 'enter the server URL' };
    try {
      await api.request('GET', '/api/v1/health', undefined, { conf: { url, token }, timeoutMs: 8000 });
      return { ok: true };
    } catch (err) {
      const c = err?.cause;
      const why = c ? c.code || c.errors?.[0]?.code || c.message : null;
      const msg = err?.status === 401 ? 'unauthorized: check the token' : `${err?.message ?? err}${why ? ` (${why})` : ''}`;
      return { ok: false, error: msg };
    }
  });

  const appOnly = (fn) => (e, ...args) => {
    if (!fromAppPage(e)) throw new Error('forbidden');
    return fn(...args);
  };
  ipcMain.handle('update:status', appOnly(() => updateView()));
  ipcMain.handle('update:check', appOnly(() => checkForUpdates()));
  ipcMain.handle('update:install', appOnly(() => installUpdateFlow()));
  ipcMain.handle('update:rollback', appOnly(() => rollbackFlow()));
  ipcMain.handle('cli:install', appOnly(() => installCli()));
  ipcMain.handle('node:useBuiltIn', appOnly(() => useBuiltInNode()));

  if (TEST) {
    ipcMain.handle('test:notificationAction', (_e, approvalId, action) => notificationAction(String(approvalId), String(action)));
    ipcMain.handle('test:trayMenu', () => (trayState ? JSON.parse(JSON.stringify(buildMenu(trayState))) : null));
  }
}

// ---------------------------------------------------------------- app menu

function appMenu() {
  const go = (label, route, accelerator) => ({ label, accelerator, click: () => showMain(route) });
  return Menu.buildFromTemplate([
    ...(IS_MAC
      ? [{
          role: 'appMenu',
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { label: 'Settings…', accelerator: 'CommandOrControl+,', click: () => openSettings() },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit', label: 'Quit Alfred' },
          ],
        }]
      : []),
    { role: 'editMenu' },
    {
      label: 'Go',
      submenu: [
        go('Open Alfred', '/', 'CommandOrControl+O'),
        go('New goal…', '/?new=goal', 'CommandOrControl+N'),
        go('New item…', '/?new=item', 'CommandOrControl+Shift+N'),
        go('Inbox', '/inbox', 'CommandOrControl+I'),
        { label: 'Quick add…', click: () => showQuick() },
        ...(IS_MAC ? [] : [{ type: 'separator' }, { label: 'Settings…', click: () => openSettings() }, { role: 'quit', label: 'Quit Alfred' }]),
      ],
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]);
}

// ---------------------------------------------------------------- lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMain());
  app.on('activate', () => showMain());
  app.on('window-all-closed', () => {
    /* stay in the menu bar */
  });
  app.on('before-quit', () => {
    quitting = true;
    clearInterval(pollTimer);
    clearInterval(updateTimer);
    clearTimeout(trayTimer);
    events?.close();
    nodeRunner.stop();
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-attach-webview', (ev) => ev.preventDefault());
  });

  app.whenReady().then(() => {
    settings = settingsStore.load(CONFIG_DIR);
    registerIpc();
    Menu.setApplicationMenu(appMenu());
    try {
      tray = createTray({ onOpen: () => showMain() });
    } catch (e) {
      console.error('[alfred-app] no tray:', e?.message ?? e);
    }
    if (settingsStore.isConfigured(settings)) createMainWindow();
    else openSettings();
    startStream();
    applyShortcut();
    applyLoginItem();
    nodeRunner.apply(settings);
    void refreshTray();
    pollTimer = setInterval(() => void refreshTray(), POLL_MS);
    // U1: check for a newer build on launch (then every 6 h) — packaged macOS builds only, never in tests.
    scheduleUpdateChecks();
    if (updateTimer) setTimeout(() => void checkForUpdates({ notify: true }), 20_000);
  });
}
