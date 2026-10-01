// P3 §3 — approval guards plus the store lookup tools need to raise one.
//
// `guardCommand` is a pure text check: it names the rule a command trips, or
// null when the command is ordinary local work. `run_shell` refuses a guarded
// command unless the task already holds an approval for that exact command
// (see store.consumeApproval), and parks the task `blocked` meanwhile.
import type { Store } from './store.js';

export interface Guard {
  name: string;
  test(cmd: string): boolean;
}

/** Command split into shell words (quotes kept as one word). */
function words(cmd: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

/** A word that is `cmd` invoked as a command: start of input or after a separator. */
function invokes(cmd: string, cmd0: string): boolean {
  const re = new RegExp(
    `(^|[;&|\\n\\r\\t (\\{]|\\$\\(|\\b(?:sudo|env|time|nohup|command|doas|xargs)\\s+)${cmd0}(?=\\s|$)`,
  );
  return re.test(cmd);
}

const isLocalHost = (host: string): boolean =>
  /^(localhost|127(\.\d{1,3}){0,3}|0(\.0){0,3}|::1|\[::1\])$/i.test(host.replace(/:\d+$/, ''));

/** Hosts of every URL / scp-style destination in the command. */
function hosts(cmd: string): string[] {
  const found: string[] = [];
  const url = /[a-z][a-z0-9+.-]*:\/\/([^\/\s"'?#]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = url.exec(cmd))) found.push(m[1]!);
  for (const w of words(cmd)) {
    if (w.startsWith('-')) continue;
    const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9._-]+):/.exec(w);
    if (scp) found.push(scp[1]!);
  }
  return found;
}

/** Does this curl/wget send something out (a body, a form, an upload, a write verb)? */
function sendsData(cmd: string): boolean {
  return (
    /(?:^|\s)-X\s*['"]?(POST|PUT|DELETE|PATCH|LINK|UNLINK)/i.test(cmd) ||
    /(?:^|\s)-(?:b|d|F|T)(?=\s|$)/.test(cmd) ||
    /(?:^|\s)--(?:data(?:-binary|-raw|-urlencode)?|form|form-string|upload-file|request|user|header)\b/i.test(cmd)
  );
}

const ROOT_TARGETS = /^(?:\/|~|\$HOME|%HOME%)(?:\/\*)?$/i;

function recursiveForceRm(cmd: string): boolean {
  for (const segment of cmd.split(/[;&|\n\r]+/)) {
    if (!invokes(segment, 'rm')) continue;
    const parts = words(segment);
    const start = parts.indexOf('rm');
    if (start < 0) continue;
    const rest = parts.slice(start + 1);
    let recursive = false;
    let force = false;
    const targets: string[] = [];
    for (const tok of rest) {
      if (!tok.startsWith('-')) {
        targets.push(tok);
        continue;
      }
      const flags = tok.replace(/^--?/, '');
      if (flags === 'recursive') recursive = true;
      if (flags === 'force') force = true;
      if (/[rf]/.test(flags)) {
        if (flags.includes('r') || flags.includes('R')) recursive = true;
        if (flags.includes('f')) force = true;
      }
    }
    if (recursive && force && targets.some((t) => ROOT_TARGETS.test(t))) return true;
  }
  return false;
}

/**
 * P10: pushes to the Spark hub (the remote named `spark`) are Alfred-internal
 * and must NOT be guarded. A command is exempt only when *every* git push in
 * it targets `spark` exactly (remote names never contain ':', which keeps
 * scp-style URLs like spark:/x out of the exemption).
 */
function hasSparkOnlyPush(cmd: string): boolean {
  let sawPush = false;
  for (const segment of cmd.split(/[;&|\n\r]+/)) {
    if (!invokes(segment, 'git')) continue;
    const parts = words(segment);
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] !== 'push') continue;
      sawPush = true;
      let remote: string | null = null;
      for (let j = i + 1; j < parts.length; j++) {
        const t = parts[j]!;
        if (t.startsWith('-')) {
          // Flags that consume the next word as their value.
          if (['-o', '--push-option', '--receive-pack', '--exec'].includes(t)) j++;
          continue;
        }
        if (!t.includes(':')) remote = t;
        break;
      }
      if (remote !== 'spark') return false;
    }
  }
  return sawPush;
}

/** Wrappers that run their argument as a command: when one is invoked, fall back to plain word matching. */
const NESTING = new Set(['bash', 'sh', 'zsh', 'dash', 'fish', 'eval', 'xargs', 'env', 'exec', 'nohup', 'timeout', 'nice', 'ionice', 'watch', 'parallel', 'find', 'su', 'doas', 'python', 'python3', 'perl', 'ruby', 'node']);
const PREFIXES = new Set(['time', 'command', 'builtin', 'then', 'do', 'else', 'if', 'while', 'until', '!', '{', '(']);

/**
 * The commands a shell line actually INVOKES (first word of every pipeline segment, after
 * VAR=value assignments and keyword prefixes), with quoted strings removed first — so
 * `grep -i 'sudo' auth.log` or `which systemctl` invoke grep/which, not sudo/systemctl.
 * Returns null when a nesting wrapper (bash -c, eval, xargs, find -exec, python -c…) is
 * invoked: then its arguments are commands too, and callers must match conservatively.
 */
export function invokedCommands(cmd: string): string[] | null {
  const unquoted = cmd.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const out: string[] = [];
  for (const seg of unquoted.split(/[;&|\n\r`]+|\$\(|\(|\)/)) {
    const parts = seg.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < parts.length && (PREFIXES.has(parts[i]!) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[i]!))) i++;
    const w = parts[i];
    if (!w) continue;
    const base = w.replace(/^.*\//, '');
    if (NESTING.has(base)) return null;
    out.push(base);
  }
  return out;
}

/** Is `name` run as a command? (conservative word match when a wrapper is involved) */
function runs(c: string, ...names: string[]): boolean {
  const inv = invokedCommands(c);
  if (inv === null) return names.some((n) => new RegExp(`\\b${n}\\b`).test(c));
  return inv.some((w) => names.includes(w));
}

const SYSTEMCTL_READ_ONLY = /\bsystemctl\s+--user\s+(?:--[\w-]+(?:=\S+)?\s+)*(status|is-active|is-enabled|is-failed|show|cat|list-units|list-timers|list-unit-files|list-dependencies)\b/;

/** Guards, checked in order. Names appear in the park reason and the approval row. */
export const GUARDS: Guard[] = [
  { name: 'git push', test: (c) => /\bgit\b/.test(c) && /\bpush\b/.test(c) && !hasSparkOnlyPush(c) },
  { name: 'gh pr', test: (c) => /\bgh\b[\s\S]*?\bpr\b[\s\S]*?\b(create|merge)\b/.test(c) },
  { name: 'gh release', test: (c) => /\bgh\b[\s\S]*?\brelease\b/.test(c) },
  { name: 'npm publish', test: (c) => /\b(npm|pnpm|yarn)\b[\s\S]*?\bpublish\b/.test(c) },
  { name: 'docker push', test: (c) => /\b(docker|podman)\b[\s\S]*?\bpush\b/.test(c) },
  { name: 'sudo', test: (c) => runs(c, 'sudo', 'doas', 'su') },
  { name: 'ssh', test: (c) => runs(c, 'ssh') },
  { name: 'scp', test: (c) => runs(c, 'scp', 'sftp') },
  {
    name: 'systemctl',
    // Every systemctl invocation must be a read-only `--user` query (restart; status in one line is not).
    test: (c) => runs(c, 'systemctl') && !c.split(/[;&|\n\r]+/).filter((seg) => runs(seg, 'systemctl')).every((seg) => SYSTEMCTL_READ_ONLY.test(seg)),
  },
  {
    name: 'curl sends data',
    test: (c) => /\b(curl|wget)\b/.test(c) && sendsData(c) && hosts(c).some((h) => !isLocalHost(h)),
  },
  { name: 'rm -rf root', test: recursiveForceRm },
  { name: 'shutdown', test: (c) => runs(c, 'shutdown', 'reboot', 'poweroff', 'halt') },
];

/**
 * ALF-7: heredoc bodies written to a file with `cat` / `tee` are file content, not commands — an agent
 * appending code that mentions "git push" used to trip the git push guard. Only those bodies are dropped,
 * and only when the line has no pipe or command substitution (`cat <<EOF | bash` runs its body) and the
 * heredoc is properly terminated. Bodies fed to anything else (bash, ssh, python, …) stay: they may run.
 */
export function stripDataHeredocs(cmd: string): string {
  const lines = cmd.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    out.push(line);
    if (/[|`]|\$\(|\beval\b/.test(line)) continue;
    const m = /(?:^|[;&]\s*)(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:\S*\/)?(?:cat|tee)\b[^<\n]*<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(line);
    if (!m) continue;
    const dash = m[1] === '-';
    const tag = m[3]!;
    let j = i + 1;
    while (j < lines.length && (dash ? lines[j]!.replace(/^\t+/, '') : lines[j]) !== tag) j++;
    if (j >= lines.length) continue; // unterminated: keep every line (conservative)
    out.push(lines[j]!);
    i = j;
  }
  return out.join('\n');
}

/** The name of the matching guard, or null. */
export function guardCommand(cmd: string): string | null {
  const text = stripDataHeredocs(String(cmd ?? ''));
  if (!text.trim()) return null;
  for (const g of GUARDS) {
    try {
      if (g.test(text)) return g.name;
    } catch {
      // A guard never breaks the runtime; an unparseable command is not guarded here.
    }
  }
  return null;
}

// --- the store behind the tools -------------------------------------------
// ToolContext (P1 contract) has no store, and run_shell must be able to raise
// and spend an approval, so openStore registers itself here and the tools find
// the store that owns the running task.
const knownStores = new Set<Store>();

export function registerApprovalStore(store: Store): void {
  knownStores.add(store);
}

export function unregisterApprovalStore(store: Store): void {
  knownStores.delete(store);
}

/** The registered store that knows this task (first match), or undefined. */
export function storeForTask(taskId: string): Store | undefined {
  for (const s of knownStores) {
    try {
      if (s.getTask(taskId)) return s;
    } catch {
      // A closed store: drop it and keep looking.
      knownStores.delete(s);
    }
  }
  return undefined;
}

// --- approval triage (Jev) ------------------------------------------------
// The guards above decide deterministically WHETHER an action needs approval. A registered
// triage (the jev module installs one when config/jev.yaml enables `approvals.mode: auto`) may
// then decide that a flagged action is safe AND what the task asked for, and let it run without
// Quinn. It is only ever consulted for agent tasks (never chat, where Quinn is present); any
// error / null / timeout = Quinn decides, exactly as without it.
export interface TriageInput {
  taskId: string;
  /** The guard or power that flagged it (e.g. 'git push', 'message'). */
  action: string;
  /** The exact command / request. */
  detail: string;
  /** Extra material Quinn would see (a message body, a diff, file content). */
  info?: string;
}

export interface TriageResult {
  /** true = run it without asking Quinn. */
  approve: boolean;
  /** One line for the approval row / task note, e.g. `Jev: safe 0.97, as asked 0.93 → auto-approved`. */
  line: string;
}

export type ApprovalTriage = (input: TriageInput) => Promise<TriageResult | null>;

let triageHook: ApprovalTriage | null = null;

export function setApprovalTriage(fn: ApprovalTriage | null): void {
  triageHook = fn;
}

/** Ask the registered triage; never throws, null when there is none or it fails. */
export async function triageApproval(input: TriageInput): Promise<TriageResult | null> {
  if (!triageHook || input.taskId.startsWith('chat:')) return null;
  try {
    const r = await triageHook(input);
    return r && typeof r.line === 'string' ? { approve: r.approve === true, line: r.line } : null;
  } catch {
    return null;
  }
}

/** Audit trail for an action Jev let through: an `approval_auto` event (goal feed / transcript)
 *  and a task note, so Quinn can always see what ran without him. Best effort, never throws. */
export function recordAutoApproval(store: Store, taskId: string, action: string, detail: string, line: string): void {
  try {
    const goalId = store.getTask(taskId)?.goalId ?? '';
    store.appendEvent(goalId, taskId, 'approval_auto', { action, detail: detail.slice(0, 2000), by: 'jev', line });
    store.appendNote(taskId, `auto-approved by Jev — ${action}: ${detail.slice(0, 300)} (${line})`);
  } catch {
    /* the action still runs; the audit is best effort */
  }
}
