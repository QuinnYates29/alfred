'use strict';
// P18 §8 — optional embedded alfred-node. Spawns the app's own binary (process.execPath) with
// ELECTRON_RUN_AS_NODE=1 and the bundled single-file node/alfred-node.mjs: no PATH, npx or nvm involved
// (launchd starts apps with a minimal PATH).
const fs = require('node:fs');
const path = require('node:path');
const { spawn: realSpawn } = require('node:child_process');
const { backoffMs } = require('./api.cjs');

const SCRIPT = path.join(__dirname, '..', 'node', 'alfred-node.mjs');

/** https://host:8443/x → wss://host:8443 (the node client appends its fixed path). */
function wsUrl(url) {
  const u = new URL(url);
  return `${u.protocol === 'https:' ? 'wss:' : 'ws:'}//${u.host}`;
}

/** Pure: argv for the node child. */
function nodeArgs(settings, script = SCRIPT) {
  const n = settings.node || {};
  return [
    script,
    '--server', wsUrl(settings.url),
    '--name', n.name || 'macbook',
    ...(n.roots || []).flatMap((r) => ['--root', r]),
    ...(n.dsh ? ['--dsh'] : []),
  ];
}

/**
 * @param {{ logFile?: string, onState?: (s: {name, running, error?}) => void, spawn?: typeof realSpawn, execPath?: string, script?: string }} o
 * apply(settings) starts/restarts/stops to match settings.node.enabled; stop() on quit.
 */
function createNodeRunner(o = {}) {
  const spawn = o.spawn ?? realSpawn;
  const execPath = o.execPath ?? process.execPath;
  const script = o.script ?? SCRIPT;
  let child = null;
  let want = null; // the settings we are running for, or null = stopped
  let failures = 0;
  let timer = null;
  let state = null;

  const emit = (s) => {
    state = s;
    try {
      o.onState?.(s);
    } catch {
      /* ignore */
    }
  };

  const log = (line) => {
    if (!o.logFile) return;
    try {
      fs.appendFileSync(o.logFile, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
    } catch {
      /* ignore */
    }
  };

  function start() {
    timer = null;
    if (!want) return;
    const s = want;
    const name = s.node.name || 'macbook';
    if (!fs.existsSync(script)) return emit({ name, running: false, error: 'node bundle missing (npm run build:node)' });
    if (!s.node.roots || s.node.roots.length === 0) return emit({ name, running: false, error: 'no roots configured' });
    const started = Date.now();
    let c;
    try {
      c = spawn(execPath, nodeArgs(s, script), {
        // The token goes in the environment, not argv: argv is visible to every process via `ps`.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ALFRED_TOKEN: s.token },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      log(`spawn failed: ${e?.message ?? e}`);
      return schedule(name);
    }
    child = c;
    emit({ name, running: true });
    const pipe = (d) => log(String(d).trimEnd().replaceAll(s.token, '***'));
    c.stdout?.on('data', pipe);
    c.stderr?.on('data', pipe);
    c.on('error', (e) => log(`child error: ${e?.message ?? e}`));
    c.on('exit', (code, sig) => {
      if (child !== c) return;
      child = null;
      log(`exited code=${code} signal=${sig}`);
      if (Date.now() - started > 60_000) failures = 0;
      if (want) schedule(name);
      else emit({ name, running: false });
    });
  }

  function schedule(name) {
    emit({ name, running: false });
    clearTimeout(timer);
    timer = setTimeout(start, backoffMs(failures++));
  }

  function kill() {
    clearTimeout(timer);
    timer = null;
    const c = child;
    child = null;
    if (c && c.exitCode === null) {
      try {
        c.kill('SIGTERM');
      } catch {
        /* gone */
      }
    }
  }

  return {
    /** Start, restart (settings changed) or stop to match settings. */
    apply(settings) {
      const enabled = Boolean(settings.node && settings.node.enabled && settings.url && settings.token);
      const key = enabled ? JSON.stringify(nodeArgs(settings, script)) : null;
      const curKey = want ? JSON.stringify(nodeArgs(want, script)) : null;
      if (key === curKey && (child || timer)) return;
      kill();
      failures = 0;
      want = enabled ? settings : null;
      if (want) start();
      else emit(settings.node && settings.node.enabled ? { name: settings.node.name, running: false } : null);
    },
    stop() {
      want = null;
      kill();
    },
    state: () => state,
  };
}

module.exports = { createNodeRunner, nodeArgs, wsUrl, SCRIPT };
