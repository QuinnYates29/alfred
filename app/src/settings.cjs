'use strict';
// P18 §2 — settings.json in ALFRED_APP_CONFIG_DIR or userData. The token is encrypted with
// safeStorage (macOS keychain) when available, else stored plain in a 0600 file. Never log it.
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_URL = 'https://gx10-de9a.tail542084.ts.net:8443';

function defaults() {
  return {
    url: DEFAULT_URL,
    token: '',
    notify: { failures: true, approvals: true, done: false, chat: true },
    launchAtLogin: false,
    shortcut: 'CommandOrControl+Shift+Space',
    node: { enabled: false, name: 'macbook', roots: [], dsh: false, messages: false, vault: '' },
    updates: { auto: true },
    bounds: null,
  };
}

/** Electron's safeStorage when running inside Electron on macOS/Windows; null elsewhere.
 *  (On Linux the keyring backend can block or silently fall back to a fixed key: plain 0600 file instead.) */
function electronSafeStorage() {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return null;
  try {
    const e = require('electron');
    if (typeof e !== 'object' || !e.safeStorage) return null;
    return e.safeStorage.isEncryptionAvailable() ? e.safeStorage : null;
  } catch {
    return null;
  }
}

function configDir() {
  if (process.env.ALFRED_APP_CONFIG_DIR) return process.env.ALFRED_APP_CONFIG_DIR;
  const e = require('electron');
  return e.app.getPath('userData');
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Defaults deep-merged (one level: notify, node) with whatever the file holds. */
function merge(raw) {
  const d = defaults();
  if (!isObj(raw)) return d;
  const out = { ...d };
  if (typeof raw.url === 'string') out.url = raw.url.trim().replace(/\/+$/, '');
  if (typeof raw.token === 'string') out.token = raw.token;
  if (typeof raw.launchAtLogin === 'boolean') out.launchAtLogin = raw.launchAtLogin;
  if (typeof raw.shortcut === 'string' && raw.shortcut.trim()) out.shortcut = raw.shortcut.trim();
  if (isObj(raw.notify)) {
    for (const k of Object.keys(d.notify)) if (typeof raw.notify[k] === 'boolean') out.notify[k] = raw.notify[k];
  }
  if (isObj(raw.node)) {
    const n = raw.node;
    out.node = {
      enabled: typeof n.enabled === 'boolean' ? n.enabled : d.node.enabled,
      name: typeof n.name === 'string' && n.name.trim() ? n.name.trim() : d.node.name,
      roots: Array.isArray(n.roots) ? n.roots.filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim()) : [],
      dsh: typeof n.dsh === 'boolean' ? n.dsh : d.node.dsh,
      messages: typeof n.messages === 'boolean' ? n.messages : d.node.messages,
      vault: typeof n.vault === 'string' ? n.vault.trim() : '',
    };
  }
  if (isObj(raw.updates) && typeof raw.updates.auto === 'boolean') out.updates = { auto: raw.updates.auto };
  if (isObj(raw.bounds) && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(raw.bounds[k]))) {
    out.bounds = { x: raw.bounds.x, y: raw.bounds.y, width: raw.bounds.width, height: raw.bounds.height };
  }
  return out;
}

/** Read settings; a missing or corrupt file gives the defaults. */
function load(dir = configDir(), safe = electronSafeStorage()) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  } catch {
    return defaults();
  }
  const s = merge(raw);
  if (isObj(raw) && typeof raw.tokenEnc === 'string' && raw.tokenEnc) {
    try {
      s.token = safe ? safe.decryptString(Buffer.from(raw.tokenEnc, 'base64')) : '';
    } catch {
      s.token = ''; // keychain refused (e.g. the app was re-signed by an update): ask again in Settings
    }
    // Not persisted (merge() drops it): tells the settings window why the token field is empty.
    if (!s.token) s.tokenLost = true;
  }
  return s;
}

/** Write settings atomically with mode 0600; the token goes out encrypted when safeStorage is available. */
function save(s, dir = configDir(), safe = electronSafeStorage()) {
  const clean = merge(s);
  const out = { ...clean };
  if (safe && clean.token) {
    delete out.token;
    out.tokenEnc = safe.encryptString(clean.token).toString('base64');
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'settings.json');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  return clean;
}

/** Whether the app has enough to connect (else the settings window opens on start). */
function isConfigured(s) {
  return Boolean(s && s.url && s.token);
}

module.exports = { DEFAULT_URL, defaults, merge, load, save, isConfigured, configDir };
