// Agent command sandbox (Linux: bubblewrap) + environment scrubbing.
//
// Every command an agent can influence (run_shell, acceptance checks, DSH /
// pipeline / langgraph runs, workspace git) goes through `sandboxedCommand()`:
//  - the child env is ALWAYS scrubbed of Alfred / Slack / API secrets (`scrubEnv`),
//    sandboxed or not;
//  - with mode 'bwrap' the child runs in a bubblewrap sandbox (own pid + ipc
//    namespace, private /tmp, the home directory replaced by an empty tmpfs with
//    only the workspace and a small toolchain allowlist bound back in).
//
// The regex guard in approvals.ts is a UX hint, not a boundary: this is the boundary.
// Stdlib only — the Mac node (src/node/client.ts) imports scrubEnv from here.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

export type SandboxMode = 'bwrap' | 'off';

export const BWRAP_PATH = '/usr/bin/bwrap';

// ---- editable policy -------------------------------------------------------------

/** Home-relative toolchain/config paths bound READ-ONLY into the sandbox (when they exist). */
export const HOME_READONLY: string[] = [
  '.gitconfig',
  '.npmrc',
  '.nvm',
  '.local/bin',
  '.local/lib',
  '.cargo',
  '.rustup',
  '.pyenv',
  '.bun',
  '.deno',
];

/**
 * Home-relative paths bound READ-WRITE. Tradeoff: package caches are shared with
 * Quinn's own builds, so an agent could poison a cached tarball/wheel that a later
 * unsandboxed build picks up. Accepted for speed (npm/pip re-downloads otherwise);
 * drop them from this list to trade speed for isolation.
 * `.dsh` is NOT here: it holds every DSH session transcript, so only the DSH executor
 * binds it (DSH_HOME_WRITABLE, passed as `writable` by executors/dsh.ts) — a plain
 * run_shell must not be able to read Quinn's other sessions. Its credentials file stays masked.
 */
export const HOME_WRITABLE: string[] = ['.cache', '.npm'];

/** Bound read-write only for the DSH executor (sessions/storages/crash logs live there). */
export const DSH_HOME_WRITABLE: string[] = ['.dsh'];

/** Home-relative files replaced by /dev/null even when a parent directory is bound. */
export const HOME_MASKED: string[] = ['.dsh/.credentials.yaml'];

/**
 * Absolute paths hidden (empty tmpfs) outside $HOME: the user's runtime dir holds the
 * systemd user bus (→ `systemctl --user`), the gpg agent and the keyring; tailscaled's
 * socket would let a command reconfigure serve/funnel.
 */
export function hiddenSystemPaths(): string[] {
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  return [...(uid >= 0 ? [`/run/user/${uid}`] : []), '/run/tailscale'];
}

// ---- env scrubbing -----------------------------------------------------------------

const SECRET_PREFIXES = ['ALFRED_', 'SLACK_', 'TWILIO_', 'ANTHROPIC_', 'OPENAI_'];
const SECRET_KEYS = new Set(['GITHUB_TOKEN', 'GH_TOKEN', 'NPM_TOKEN']);
const SECRET_RE = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|CREDENTIAL)/i;

/** True when an env var name looks like it carries a secret (dropped by scrubEnv). */
export function isSecretEnvKey(key: string): boolean {
  const up = key.toUpperCase();
  if (SECRET_PREFIXES.some((p) => up.startsWith(p))) return true;
  if (SECRET_KEYS.has(up)) return true;
  return SECRET_RE.test(key);
}

/** A copy of env without Alfred/Slack/Twilio/LLM/GitHub/npm secrets or anything secret-named. */
export function scrubEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || isSecretEnvKey(k)) continue;
    out[k] = v;
  }
  return out;
}

// ---- bwrap argv --------------------------------------------------------------------

export interface SandboxSpawnOpts {
  /** The directory the command works in: bound read-write. */
  workspace: string;
  /** Extra read-write binds. */
  writable?: string[];
  /** Extra read-only binds (e.g. a tool's install dir under $HOME). */
  readonly?: string[];
  /** Default true. false = --unshare-net (no network at all). */
  network?: boolean;
  /** Working directory inside the sandbox (default: workspace). Must be visible inside. */
  cwd?: string;
  /** Overrides for tests. */
  home?: string;
  /** Root(s) of the Spark bare-repo hub (bound rw, each repo's hooks/ + config read-only). */
  gitHub?: string | string[];
  bwrap?: string;
}

interface Bind {
  src: string;
  dest: string;
  kind: 'rw' | 'ro' | 'mask';
}

function real(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Protect a git dir that is bound read-write: hooks/ and config are re-bound
 * read-only, so a sandboxed command cannot plant a hook or a config-driven
 * command (core.hooksPath, core.fsmonitor, core.sshCommand, filters…) that a later
 * UNsandboxed git run (Quinn's shell, Alfred's own git) would execute.
 */
function gitDirProtections(gitDir: string): Bind[] {
  const out: Bind[] = [];
  for (const name of ['hooks', 'config']) {
    const p = path.join(gitDir, name);
    const rp = real(p);
    if (rp) out.push({ src: rp, dest: rp, kind: 'ro' });
  }
  return out;
}

/** For a linked worktree (`.git` file), the common git dir that must be writable for commits. */
function worktreeCommonDir(ws: string): string | null {
  const dotgit = path.join(ws, '.git');
  try {
    if (!lstatSync(dotgit).isFile()) return null;
    const m = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotgit, 'utf8'));
    if (!m) return null;
    const gitdir = path.resolve(ws, m[1]!.trim());
    let common = gitdir;
    const cf = path.join(gitdir, 'commondir');
    if (existsSync(cf)) common = path.resolve(gitdir, readFileSync(cf, 'utf8').trim());
    return real(common);
  } catch {
    return null;
  }
}

function depth(p: string): number {
  return p.split('/').filter(Boolean).length;
}

/**
 * The bubblewrap argv for running `cmd` under the policy. Pure apart from
 * filesystem existence checks (paths that don't exist are skipped).
 */
export function sandboxSpawnArgs(cmd: string[], o: SandboxSpawnOpts): { file: string; args: string[] } {
  const home = real(o.home ?? homedir()) ?? path.resolve(o.home ?? homedir());
  const ws = real(o.workspace) ?? path.resolve(o.workspace);
  const cwd = o.cwd ? real(o.cwd) ?? path.resolve(o.cwd) : ws;

  const args: string[] = [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    '--unshare-pid',
    '--unshare-ipc',
    '--die-with-parent',
    '--new-session',
  ];
  if (o.network === false) args.push('--unshare-net');
  // Hide the whole home, and the runtime sockets outside it.
  args.push('--tmpfs', home);
  for (const h of hiddenSystemPaths()) if (isDir(h)) args.push('--tmpfs', h);

  const binds: Bind[] = [];
  const add = (p: string | undefined, kind: Bind['kind']) => {
    if (!p) return;
    const rp = real(p);
    if (rp) binds.push({ src: rp, dest: rp, kind });
  };
  for (const rel of HOME_READONLY) add(path.join(home, rel), 'ro');
  for (const rel of HOME_WRITABLE) add(path.join(home, rel), 'rw');
  for (const p of o.readonly ?? []) add(p, 'ro');

  // The Spark git hub: rw so `git push spark …` works; each bare repo's hooks/ and
  // config read-only (no planted hooks; SB's pre-receive hook stays authoritative).
  for (const g of typeof o.gitHub === 'string' ? [o.gitHub] : o.gitHub ?? []) {
    const hub = real(g);
    if (hub && isDir(hub)) {
      binds.push({ src: hub, dest: hub, kind: 'rw' });
      let names: string[] = [];
      try {
        names = readdirSync(hub);
      } catch {
        /* unreadable hub: nothing to protect */
      }
      for (const n of names) {
        const bare = path.join(hub, n);
        if (isDir(bare)) binds.push(...gitDirProtections(bare));
      }
    }
  }

  // The workspace (rw) and its git metadata.
  binds.push({ src: ws, dest: ws, kind: 'rw' });
  const dotgit = path.join(ws, '.git');
  if (isDir(dotgit)) binds.push(...gitDirProtections(dotgit));
  const common = worktreeCommonDir(ws);
  if (common) {
    binds.push({ src: common, dest: common, kind: 'rw' });
    binds.push(...gitDirProtections(common));
  }
  for (const p of o.writable ?? []) add(p, 'rw');
  for (const rel of HOME_MASKED) {
    const p = path.join(home, rel);
    if (existsSync(p)) binds.push({ src: '/dev/null', dest: p, kind: 'mask' });
  }

  // Parents before children so later (deeper) binds overlay earlier ones; masks last.
  const ordered = binds
    .map((b, i) => ({ b, i }))
    .sort((x, y) => {
      const mx = x.b.kind === 'mask' ? 1 : 0;
      const my = y.b.kind === 'mask' ? 1 : 0;
      if (mx !== my) return mx - my;
      return depth(x.b.dest) - depth(y.b.dest) || x.i - y.i;
    })
    .map((x) => x.b);
  for (const b of ordered) {
    if (b.kind === 'rw') args.push('--bind', b.src, b.dest);
    else args.push('--ro-bind', b.src, b.dest);
  }
  args.push('--chdir', cwd, '--', ...cmd);
  return { file: o.bwrap ?? BWRAP_PATH, args };
}

// ---- active configuration ------------------------------------------------------------

interface SandboxState {
  /** What was asked for. */
  requested: SandboxMode;
  /** What is in force ('off' when bwrap is missing or failed its self-test). */
  mode: SandboxMode;
  gitHub?: string;
  reason?: string;
}

function parseMode(v: unknown): SandboxMode | undefined {
  return v === 'bwrap' || v === 'off' ? v : undefined;
}

let state: SandboxState = { requested: 'off', mode: 'off' };
/** Hub roots seen by resolveWorkspace (the configured one is added by configureSandbox). */
const gitHubs = new Set<string>();

/** Make a bare-repo hub root pushable from inside the sandbox (hooks/config stay read-only). */
export function registerGitHub(root: string): void {
  gitHubs.add(path.resolve(root));
}
let initialised = false;

/** Run a trivial command under the real policy; null = OK, else the failure. */
export function bwrapSelfTest(bwrap = BWRAP_PATH): string | null {
  if (!existsSync(bwrap)) return `${bwrap} not found`;
  try {
    const ws = real(tmpdir()) ?? '/tmp';
    const { file, args } = sandboxSpawnArgs(['/bin/true'], { workspace: ws, bwrap });
    const r = spawnSync(file, args, { timeout: 10_000, env: scrubEnv(process.env), stdio: ['ignore', 'ignore', 'pipe'] });
    if (r.error) return r.error.message;
    if (r.status !== 0) return `exit ${r.status}: ${String(r.stderr ?? '').trim().slice(0, 300)}`;
    return null;
  } catch (e: any) {
    return e?.message ?? String(e);
  }
}

/**
 * Set the sandbox for this process. `ALFRED_SANDBOX=bwrap|off` in the env wins over
 * `mode`. Mode 'bwrap' is self-tested; on failure a LOUD warning is logged and
 * commands run unsandboxed (still with the scrubbed env).
 */
export function configureSandbox(o: {
  mode?: SandboxMode;
  env?: Record<string, string | undefined>;
  gitHub?: string;
  log?: (msg: string) => void;
} = {}): SandboxState {
  const env = o.env ?? process.env;
  const requested = parseMode(env.ALFRED_SANDBOX) ?? parseMode(process.env.ALFRED_SANDBOX) ?? o.mode ?? 'off';
  const log = o.log ?? ((m: string) => console.error(m));
  let mode: SandboxMode = requested;
  let reason: string | undefined;
  if (requested === 'bwrap') {
    const err = bwrapSelfTest();
    if (err) {
      mode = 'off';
      reason = err;
      log(
        [
          '',
          '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
          `!!! ALFRED SANDBOX DISABLED: bubblewrap self-test failed (${err})`,
          '!!! Agent commands will run UNSANDBOXED as this user (env is still scrubbed).',
          '!!! Install bubblewrap (/usr/bin/bwrap) and allow unprivileged user namespaces.',
          '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
          '',
        ].join('\n'),
      );
    }
  }
  if (o.gitHub) registerGitHub(o.gitHub);
  state = { requested, mode, ...(o.gitHub ? { gitHub: o.gitHub } : {}), ...(reason ? { reason } : {}) };
  initialised = true;
  return { ...state };
}

/** The sandbox in force (first use without configureSandbox honours ALFRED_SANDBOX). */
export function sandboxState(): SandboxState {
  if (!initialised) configureSandbox({ log: (m) => console.error(m) });
  return { ...state };
}

export interface SandboxedCommandOpts extends Omit<SandboxSpawnOpts, 'home' | 'gitHub' | 'bwrap'> {
  /** Env vars added AFTER scrubbing (e.g. PYTHONPATH). Never put secrets here. */
  extraEnv?: Record<string, string>;
  /** Base env to scrub (default process.env). */
  env?: Record<string, string | undefined>;
  /** Force a mode for this call (tests). */
  mode?: SandboxMode;
}

/**
 * What to spawn for an agent-influenced command: `{file, args, env, cwd}`. With the
 * sandbox off this is the command itself with a scrubbed env.
 */
export function sandboxedCommand(
  file: string,
  args: string[],
  o: SandboxedCommandOpts,
): { file: string; args: string[]; env: Record<string, string>; cwd: string; sandboxed: boolean } {
  const st = sandboxState();
  const mode = o.mode ?? st.mode;
  const env = { ...scrubEnv(o.env ?? process.env), ...(o.extraEnv ?? {}) };
  const cwd = o.cwd ?? o.workspace;
  if (mode !== 'bwrap') return { file, args, env, cwd, sandboxed: false };
  // An executable named by absolute path (a configured tool binary) must be visible inside.
  const readonly = [...(o.readonly ?? []), ...(path.isAbsolute(file) ? [path.dirname(file)] : [])];
  const w = sandboxSpawnArgs([file, ...args], { ...o, readonly, gitHub: [...gitHubs] });
  // bwrap itself chdirs; spawn from '/' so a hidden cwd can't fail the spawn.
  return { file: w.file, args: w.args, env, cwd: '/', sandboxed: true };
}
