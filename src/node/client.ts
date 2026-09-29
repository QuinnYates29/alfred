// P9 §4 — alfred-node: the laptop daemon. Dials OUT to the Alfred server,
// serves fs/exec calls inside its roots, shows desktop notifications.
// Depends only on `ws` + Node stdlib (it runs on the Mac via `npx tsx`).
import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import {
  COMMS_CAP,
  MAX_MESSAGE_CHARS,
  PROTOCOL_VERSION,
  VAULT_CAP,
  encode,
  guardRoot,
  normalizeHandle,
  normalizePhone,
  outsideRoots,
  parseMsg,
  tailOut,
  vaultHello,
  type CallMsg,
  type CommsOp,
  type CommsResult,
  type NodeMsg,
  type VaultOp,
} from './protocol.js';
import { runVaultOp } from './vault.js';
import { writeFileNoFollow } from '../pathguard.js';
import { scrubEnv } from '../sandbox.js';

export interface ConnectNodeOpts {
  /** ws:// or wss:// host[:port] (path is fixed: /api/nodes/connect). */
  url: string;
  token?: string;
  name: string;
  roots: string[];
  caps?: string[];
  /** Default true: reconnect with backoff 1 s → 30 s. */
  reconnect?: boolean;
  /** Default: osascript on macOS, notify-send on Linux. */
  onNotify?: (n: { level: string; title: string; body: string; url?: string }) => void;
  /** P10: sandbox workspace location on this machine (must be inside roots). Default <first root>/alfred-sandbox. */
  sandbox?: string;
  /** P21b: runs sendMessage/placeCall (caps `messages`/`calls`). Default: osascript → Messages.app / `open tel:` on macOS. */
  comms?: CommsRunner;
  /** V1: absolute path of the Obsidian vault this node serves → cap `vault` (hello reports its basename only). NOT a root. */
  vault?: string;
}

const VAULT_OPS: VaultOp[] = ['vaultList', 'vaultRead', 'vaultSearch', 'vaultWrite', 'vaultAppend', 'vaultMove'];
/** Expand a leading `~` (the CLI and the app both accept ~/paths). */
export const expandHome = (p: string): string => p.replace(/^~(?=\/|$)/, process.env.HOME ?? '~');

export interface CommsRunner {
  run(op: CommsOp, args: { to: string; text?: string }): Promise<CommsResult>;
}

export interface NodeHandle {
  close(): void;
  connected(): boolean;
}

type RunningChild = ReturnType<typeof spawn>;

const NOTIFY_SCRIPT = [
  'on run argv',
  '  set xs to argv',
  '  if (count of xs) > 0 and item 1 of xs is "--" then set xs to rest of xs',
  '  display notification (item 2 of xs) with title "Alfred" subtitle (item 1 of xs)',
  'end run',
].join('\n');

function defaultNotify(n: { level: string; title: string; body: string; url?: string }): void {
  try {
    if (process.platform === 'darwin') {
      // Fixed script; title/body arrive as argv (never spliced into AppleScript: a trailing
      // backslash or quote in a goal title would otherwise turn the rest into code).
      const body = `${n.body}${n.url ? ` — ${n.url}` : ''}`;
      const child = spawn('osascript', ['-e', NOTIFY_SCRIPT, '--', `${n.title}`, body]);
      child.on('error', () => {});
      child.unref();
    } else {
      const urgency = n.level === 'failure' ? 'critical' : n.level === 'warn' ? 'normal' : 'low';
      const child = spawn('notify-send', ['-a', 'Alfred', '-u', urgency, n.title, `${n.body}${n.url ? ` — ${n.url}` : ''}`]);
      child.on('error', () => {});
      child.unref();
    }
  } catch {
    /* a notification must never crash the node */
  }
}

// ---- P21b: texting and calling from the Mac -------------------------------------
// The AppleScript is a FIXED string: recipient and text arrive as `on run argv` items,
// passed as separate argv elements to osascript via execFile (no shell). User text is
// never concatenated into a script. If osascript leaves a literal "--" in argv, skip it.
export const MESSAGES_SCRIPT = [
  'on run argv',
  '  set i to 1',
  '  if (count of argv) > 2 and item 1 of argv is "--" then set i to 2',
  '  set theTo to item i of argv',
  '  set theText to item (i + 1) of argv',
  '  tell application "Messages"',
  '    try',
  '      set svc to 1st account whose service type = iMessage',
  '      send theText to participant theTo of svc',
  '    on error',
  '      set svc to 1st account whose service type = SMS',
  '      send theText to participant theTo of svc',
  '    end try',
  '  end tell',
  'end run',
].join('\n');

/** The exact argv for each op (program + args) — exported for tests; no shell anywhere. */
export function commsArgv(op: CommsOp, args: { to: string; text?: string }): [string, string[]] {
  if (op === 'sendMessage') return ['osascript', ['-e', MESSAGES_SCRIPT, '--', args.to, args.text ?? '']];
  return ['open', [`tel:${args.to}`]];
}

const defaultComms: CommsRunner = {
  run(op, args) {
    if (process.platform !== 'darwin') return Promise.resolve({ ok: false, error: `${op} needs macOS (Messages.app / iPhone handoff)` });
    const [file, argv] = commsArgv(op, args);
    return new Promise((resolve) => {
      execFile(file, argv, { timeout: 25_000 }, (err, _stdout, stderr) => {
        if (err) resolve({ ok: false, error: `${file} failed: ${String(stderr || err.message).trim().slice(0, 300)}` });
        else resolve({ ok: true });
      });
    });
  },
};

/** Validate a comms call on the node side too (the server validates first; the node trusts nothing). */
async function runComms(op: CommsOp, args: any, caps: string[], runner: CommsRunner): Promise<CommsResult> {
  if (!caps.includes(COMMS_CAP[op])) return { ok: false, error: `${op} is not enabled on this node (start alfred-node with --messages)` };
  if (op === 'sendMessage') {
    const to = normalizeHandle(args?.to);
    if (!to) return { ok: false, error: `invalid recipient: ${String(args?.to ?? '')}` };
    const text = args?.text;
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'text is required' };
    if (text.length > MAX_MESSAGE_CHARS || text.includes('\0')) return { ok: false, error: `text must be ≤ ${MAX_MESSAGE_CHARS} characters` };
    return runner.run(op, { to, text });
  }
  const to = normalizePhone(args?.to);
  if (!to) return { ok: false, error: `invalid phone number: ${String(args?.to ?? '')}` };
  return runner.run(op, { to });
}

// ---- exec sandbox (macOS: sandbox-exec) ----------------------------------------------
// exec children never get the node's env secrets (ALFRED_TOKEN, …): scrubEnv. On macOS
// they also run under a Seatbelt profile: no read/write of the login-persistence,
// keychain, Messages, ssh and Alfred token stores; writes only inside the node's roots,
// temp dirs and /dev. Everything else (reads, network, process exec) stays allowed.
// Paths arrive as -D parameters, never spliced into the profile text.

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** Home-relative paths an exec child may neither read nor write. */
export const MAC_DENY_HOME = [
  'Library/LaunchAgents',
  'Library/Keychains',
  'Library/Messages',
  '.ssh',
  '.config/alfred',
  'Library/Application Support/Alfred',
];

/** Writable besides the roots. */
export const MAC_WRITABLE = ['/tmp', '/private/tmp', '/private/var/folders', '/dev'];

/** The Seatbelt profile for `nRoots` roots (params HOME, ROOT0…ROOTn-1). */
export function macSandboxProfile(nRoots: number): string {
  const deny = MAC_DENY_HOME.map((rel, i) => `  (subpath (string-append (param "HOME") "/${rel}"))`).join('\n');
  const roots = Array.from({ length: nRoots }, (_, i) => `    (subpath (param "ROOT${i}"))`).join('\n');
  const extra = MAC_WRITABLE.map((p) => `    (subpath "${p}")`).join('\n');
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-read* file-write*',
    deny,
    ')',
    '(deny file-write*',
    '  (require-not (require-any',
    roots,
    extra,
    '  )))',
  ].join('\n');
}

function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** [file, argv] for an exec child on this platform (exported for tests). */
export function execArgv(
  cmd: string,
  o: { roots: string[]; home: string; platform?: string; sandboxExec?: string | null },
): [string, string[]] {
  const platform = o.platform ?? process.platform;
  const sx = o.sandboxExec === undefined ? SANDBOX_EXEC : o.sandboxExec;
  if (platform !== 'darwin' || !sx) return ['bash', ['-c', cmd]];
  const args: string[] = ['-D', `HOME=${realOr(o.home)}`];
  o.roots.forEach((r, i) => args.push('-D', `ROOT${i}=${realOr(r)}`));
  args.push('-p', macSandboxProfile(o.roots.length), '/bin/bash', '-c', cmd);
  return [sx, args];
}

let warnedNoSandboxExec = false;
function sandboxExecPath(): string | null {
  if (process.platform !== 'darwin') return null;
  if (existsSync(SANDBOX_EXEC)) return SANDBOX_EXEC;
  if (!warnedNoSandboxExec) {
    warnedNoSandboxExec = true;
    console.error(`[alfred-node] WARNING: ${SANDBOX_EXEC} missing — exec runs unsandboxed (env still scrubbed)`);
  }
  return null;
}

function runExec(callId: string, args: any): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
  const cmd = String(args?.cmd ?? '');
  const cwd = String(args?.cwd ?? process.cwd());
  const timeoutMs = Number(args?.timeoutMs) > 0 ? Number(args.timeoutMs) : 60_000;
  return new Promise((resolve) => {
    let child: RunningChild;
    try {
      const [file, argv] = execArgv(cmd, {
        roots: rootsGlobal,
        home: process.env.HOME ?? '',
        sandboxExec: sandboxExecPath(),
      });
      child = spawn(file, argv, { cwd, env: scrubEnv(process.env), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e: any) {
      resolve({ exitCode: -1, output: `spawn failed: ${e?.message ?? e}`, timedOut: false });
      return;
    }
    running.set(callId, child);
    let out = '';
    let timedOut = false;
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    child.stdout?.on('data', (b: Buffer) => {
      out += b.toString('utf8');
      if (out.length > 32_000) out = out.slice(-16_000);
    });
    child.stderr?.on('data', (b: Buffer) => {
      out += b.toString('utf8');
      if (out.length > 32_000) out = out.slice(-16_000);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, output: `${out}\nspawn error: ${e.message}`, timedOut: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: timedOut ? null : code, output: tailOut(out), timedOut });
    });
  });
}

// exec bookkeeping (call id → child, so `cancel` can kill the process group)
const running = new Map<string, RunningChild>();

function handleOp(
  callId: string,
  op: string,
  args: any,
  node: { caps: string[]; comms: CommsRunner; vault?: string },
): Promise<any> {
  if ((VAULT_OPS as string[]).includes(op)) {
    if (!node.vault) return Promise.reject(new Error('this node has no vault (start alfred-node with --vault <path>)'));
    if (!node.caps.includes(VAULT_CAP)) return Promise.reject(new Error('vault ops are not enabled on this node'));
    // A vault refusal is an Error with honest text; the caller turns it into {ok:false,error}.
    return Promise.resolve().then(() => runVaultOp(node.vault!, op, args));
  }
  switch (op) {
    case 'sendMessage':
    case 'placeCall':
      return runComms(op, args, node.caps, node.comms);
    case 'ping':
      return Promise.resolve({ pong: true });
    case 'readFile': {
      const p = guardRoot(rootsGlobal, args?.path);
      if (!p) return Promise.reject(new Error(outsideRoots(args?.path)));
      return Promise.resolve(readFileSync(p, 'utf8'));
    }
    case 'writeFile': {
      const p = guardRoot(rootsGlobal, args?.path, { write: true });
      if (!p) return Promise.reject(new Error(outsideRoots(args?.path)));
      writeFileNoFollow(p, String(args?.content ?? ''));
      return Promise.resolve(true);
    }
    case 'listDir': {
      const p = guardRoot(rootsGlobal, args?.path);
      if (!p) return Promise.reject(new Error(outsideRoots(args?.path)));
      const entries = readdirSync(p, { withFileTypes: true }).map((e) => {
        let dir = e.isDirectory();
        try {
          dir = statSync(path.join(p, e.name)).isDirectory();
        } catch {
          /* dangling symlink */
        }
        return { name: e.name, dir };
      });
      return Promise.resolve(entries);
    }
    case 'exec': {
      const cwd = guardRoot(rootsGlobal, args?.cwd ?? rootsGlobal[0]);
      if (!cwd) return Promise.reject(new Error(outsideRoots(args?.cwd)));
      return runExec(callId, { ...args, cwd });
    }
    case 'cancel': {
      const id = String(args?.callId ?? '');
      const child = running.get(id);
      if (child) {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      return Promise.resolve(true);
    }
    default:
      return Promise.reject(new Error(`unknown op: ${op}`));
  }
}

let rootsGlobal: string[] = [];

export function connectNode(o: ConnectNodeOpts): NodeHandle {
  const caps = [...(o.caps ?? ['fs', 'shell', 'git'])];
  // V1: with --vault the node serves vault ops; the vault dir is NOT a root (general fs/exec must never reach it).
  const vaultDir = o.vault ? path.resolve(expandHome(o.vault)) : null;
  if (vaultDir && !caps.includes(VAULT_CAP)) caps.push(VAULT_CAP);
  const reconnect = o.reconnect !== false;
  const onNotify = o.onNotify ?? defaultNotify;
  const nodeCtx = { caps, comms: o.comms ?? defaultComms, ...(vaultDir ? { vault: vaultDir } : {}) };
  rootsGlobal = o.roots.map((r) => path.resolve(r));
  const sandboxWant = path.resolve(
    (o.sandbox ?? `${process.env.HOME ?? '~'}${path.sep}alfred-sandbox`).replace(/^~(?=\/|$)/, process.env.HOME ?? '~'),
  );
  // The sandbox must live inside the node's roots; if it doesn't, fall back to the first root.
  const sandbox = guardRoot(rootsGlobal, sandboxWant) ? sandboxWant : path.join(rootsGlobal[0] ?? process.cwd(), 'alfred-sandbox');

  let ws: WebSocket | null = null;
  let closedByUs = false;
  let backoffMs = 1_000;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let open = false;

  const target = () => {
    const u = new URL(o.url);
    u.pathname = '/api/nodes/connect';
    u.search = o.token ? `?token=${encodeURIComponent(o.token)}` : '';
    return u.toString();
  };

  const connect = () => {
    if (closedByUs) return;
    try {
      ws = new WebSocket(target(), { maxPayload: 32 * 1024 * 1024 });
    } catch {
      schedule();
      return;
    }
    ws.on('open', () => {
      open = true;
      backoffMs = 1_000;
      const hello = {
        type: 'hello', name: o.name, roots: rootsGlobal, caps, version: PROTOCOL_VERSION, sandbox,
        ...(vaultDir ? { vault: vaultHello(vaultDir) } : {}),
      };
      ws!.send(encode(hello as NodeMsg));
    });
    ws.on('message', (data: any) => {
      const msg = parseMsg(String(data));
      if (!msg) return;
      if (msg.type === 'notify') {
        try {
          onNotify({ level: msg.level, title: msg.title, body: msg.body, ...(msg.url ? { url: msg.url } : {}) });
        } catch {
          /* never crash on a bad notification */
        }
        return;
      }
      if (msg.type !== 'call') return;
      const call = msg as CallMsg;
      Promise.resolve()
        .then(() => handleOp(call.id, call.op, call.args, nodeCtx))
        .then(
          (value) => send({ type: 'result', id: call.id, ok: true, value }),
          (e: any) => send({ type: 'result', id: call.id, ok: false, error: e?.message ?? String(e) }),
        )
        .finally(() => {
          running.delete(call.id);
        });
    });
    const gone = () => {
      open = false;
      if (!closedByUs) schedule();
    };
    ws.on('close', gone);
    ws.on('error', () => {
      /* close follows */
    });
  };

  const send = (m: NodeMsg) => {
    if (ws && open) {
      try {
        ws.send(encode(m));
      } catch {
        /* socket gone */
      }
    }
  };

  const schedule = () => {
    if (closedByUs || !reconnect || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 30_000);
  };

  connect();

  return {
    close() {
      closedByUs = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      try {
        ws?.close();
      } catch {
        /* already gone */
      }
    },
    connected: () => open,
  };
}

// ---- CLI: alfred-node --server ws://host:port --token T --name macbook --root ~/code [--root …] [--dsh] [--messages]
/* istanbul ignore next — daemon entry, exercised manually on the Mac */
function cliMain(argv: string[]): void {
  const o: { url?: string; token?: string; name?: string; roots: string[]; caps: string[]; vault?: string } = {
    roots: [],
    // macOS: desktop notifications on by default (--no-notify when the Mac app shows them itself)
    caps: process.platform === 'darwin' ? ['fs', 'shell', 'git', 'notify'] : ['fs', 'shell', 'git'],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? '';
    if (a === '--server') o.url = next();
    else if (a === '--token') o.token = next();
    else if (a === '--name') o.name = next();
    else if (a === '--root') o.roots.push(path.resolve(next().replace(/^~(?=\/|$)/, process.env.HOME ?? '~')));
    else if (a === '--dsh') o.caps.push('dsh', 'notify');
    else if (a === '--notify') { if (!o.caps.includes('notify')) o.caps.push('notify'); }
    else if (a === '--no-notify') o.caps = o.caps.filter((c) => c !== 'notify');
    else if (a === '--messages') { for (const c of ['messages', 'calls']) if (!o.caps.includes(c)) o.caps.push(c); }
    else if (a === '--vault') o.vault = next();
    else if (a === '--help' || a === '-h') {
      console.log('usage: alfred-node --server ws(s)://host:port --token $ALFRED_TOKEN --name <name> --root <abs> [--root …] [--dsh] [--notify|--no-notify] [--messages]');
      process.exit(0);
    }
  }
  if (!o.url || !o.name || o.roots.length === 0) {
    console.error('usage: alfred-node --server ws(s)://host:port --token $ALFRED_TOKEN --name <name> --root <abs> [--root …] [--dsh] [--notify|--no-notify] [--messages]');
    process.exit(2);
  }
  const token = o.token ?? process.env.ALFRED_TOKEN;
  const handle = connectNode({
    url: o.url,
    ...(token ? { token } : {}),
    name: o.name,
    roots: o.roots,
    caps: o.caps,
    ...(o.vault ? { vault: expandHome(o.vault) } : {}),
  });
  console.log(`alfred-node "${o.name}" → ${o.url} roots=${o.roots.join(',')}${o.vault ? ` vault=${o.vault}` : ''} caps=${o.caps.join(',')}`);
  const bye = () => { handle.close(); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

if (process.argv[1] && /(^|[\\/])(client|alfred-node)[.]tsx?$/.test(process.argv[1])) cliMain(process.argv.slice(2));
