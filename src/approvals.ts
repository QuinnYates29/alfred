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

/** Guards, checked in order. Names appear in the park reason and the approval row. */
export const GUARDS: Guard[] = [
  { name: 'git push', test: (c) => /\bgit\b/.test(c) && /\bpush\b/.test(c) },
  { name: 'gh pr', test: (c) => /\bgh\b[\s\S]*?\bpr\b[\s\S]*?\b(create|merge)\b/.test(c) },
  { name: 'gh release', test: (c) => /\bgh\b[\s\S]*?\brelease\b/.test(c) },
  { name: 'npm publish', test: (c) => /\b(npm|pnpm|yarn)\b[\s\S]*?\bpublish\b/.test(c) },
  { name: 'docker push', test: (c) => /\b(docker|podman)\b[\s\S]*?\bpush\b/.test(c) },
  { name: 'sudo', test: (c) => /\bsudo\b/.test(c) },
  { name: 'ssh', test: (c) => /\bssh\b/.test(c) },
  { name: 'scp', test: (c) => /\bscp\b/.test(c) },
  {
    name: 'systemctl',
    test: (c) => /\bsystemctl\b/.test(c) && !/--user[\s\S]*?\b(status|is-active|is-enabled|show|cat)\b/.test(c),
  },
  {
    name: 'curl sends data',
    test: (c) => /\b(curl|wget)\b/.test(c) && sendsData(c) && hosts(c).some((h) => !isLocalHost(h)),
  },
  { name: 'rm -rf root', test: recursiveForceRm },
  { name: 'shutdown', test: (c) => /\b(shutdown|reboot|poweroff|halt)\b/.test(c) },
];

/** The name of the matching guard, or null. */
export function guardCommand(cmd: string): string | null {
  const text = String(cmd ?? '');
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
