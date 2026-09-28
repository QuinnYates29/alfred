'use strict';
// U1 — "enter the token once": the CLI config written from the app's settings, and switching from the old
// LaunchAgent node (deploy/node-install-macos.sh) to the app's built-in node so the Mac never connects twice.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile: realExecFile } = require('node:child_process');

const cliConfigPath = (home = os.homedir()) => path.join(home, '.config', 'alfred', 'cli.json');

/** ~/.config/alfred/cli.json in the format `alfred login` writes ({url, token}), mode 0600, atomically. */
function writeCliConfig(url, token, file = cliConfigPath()) {
  if (!url) throw new Error('no server URL configured');
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ url: String(url).replace(/\/+$/, ''), token: String(token ?? '') }), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  return file;
}

/** Copy the bundled CLI to ~/.local/bin/alfred (0755) and write cli.json. Returns the paths. */
function installCli({ src, url, token, home = os.homedir() }) {
  if (!fs.existsSync(src)) throw Object.assign(new Error('the command-line tool is not bundled in this build'), { code: 'NO_CLI' });
  const bin = path.join(home, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const dest = path.join(bin, 'alfred');
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.copyFileSync(src, tmp);
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, dest); // replaces the LaunchAgent-era shim too
  const cfg = writeCliConfig(url, token, cliConfigPath(home));
  return { bin: dest, config: cfg };
}

const launchAgentPath = (home = os.homedir()) => path.join(home, 'Library', 'LaunchAgents', 'com.alfred.node.plist');

const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** name/roots/dsh/messages from the LaunchAgent's ProgramArguments (to prefill the built-in node). */
function parseLaunchAgent(xml) {
  const arr = /<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(String(xml));
  if (!arr) return null;
  const args = [...arr[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => unxml(m[1]));
  const out = { name: null, roots: [], dsh: false, messages: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name' && args[i + 1]) out.name = args[++i];
    else if (args[i] === '--root' && args[i + 1]) out.roots.push(args[++i]);
    else if (args[i] === '--dsh') out.dsh = true;
    else if (args[i] === '--messages') out.messages = true;
  }
  return out;
}

/** Whether the old LaunchAgent is installed (and what it ran). */
function launchAgentInfo(home = os.homedir()) {
  const plist = launchAgentPath(home);
  if (!fs.existsSync(plist)) return null;
  let parsed = null;
  try {
    parsed = parseLaunchAgent(fs.readFileSync(plist, 'utf8'));
  } catch {
    /* unreadable: still offer to disable */
  }
  return { plist, ...(parsed || { name: null, roots: [], dsh: false, messages: false }) };
}

/**
 * `launchctl unload <plist>` then move it to <plist>.disabled (launchd ignores that name).
 * Returns { ok, disabled, warning? } — an unload failure (not loaded) is only a warning.
 */
function disableLaunchAgent({ home = os.homedir(), execFile = realExecFile } = {}) {
  const plist = launchAgentPath(home);
  if (!fs.existsSync(plist)) return Promise.resolve({ ok: false, error: 'no LaunchAgent installed' });
  return new Promise((resolve) => {
    execFile('/bin/launchctl', ['unload', plist], { timeout: 20_000 }, (err, _o, stderr) => {
      const warning = err ? `launchctl unload: ${String(stderr || err.message).trim()}` : undefined;
      try {
        const disabled = `${plist}.disabled`;
        fs.rmSync(disabled, { force: true });
        fs.renameSync(plist, disabled);
        resolve({ ok: true, disabled, ...(warning ? { warning } : {}) });
      } catch (e) {
        resolve({ ok: false, error: e?.message ?? String(e) });
      }
    });
  });
}

module.exports = { cliConfigPath, writeCliConfig, installCli, launchAgentPath, parseLaunchAgent, launchAgentInfo, disableLaunchAgent };
