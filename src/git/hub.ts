// P10 §1 — the repo hub on the Spark. One bare repo per project under
// ~/.alfred/git; every Alfred workspace (Spark or node) pushes to and clones
// from it, so work is connected between machines without GitHub.
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Run one git command; rejects with the combined output on a non-zero exit. */
async function git(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await run('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (e: any) {
    const out = `${e?.stdout ?? ''}${e?.stderr ?? ''}`.trim() || e?.message || String(e);
    throw new Error(`git ${args.join(' ')} failed: ${out.slice(-800)}`);
  }
}

/** Marker line: a hook alfred wrote (and may rewrite). */
const HOOK_MARK = '# alfred-protect-base v1';

/**
 * pre-receive: nobody may PUSH to a base branch (master, main, the repo's HEAD branch, or one listed
 * in `alfred-protected-branches`). Agents land work on their own branches; alfred's reviewed merge
 * updates the base with `git fetch` + `git update-ref` inside the bare repo, which runs no receive
 * hooks — so there is no bypass switch a pusher could set (no env var, no push option).
 */
export const PRE_RECEIVE_HOOK = `#!/bin/sh
${HOOK_MARK}
# Base branches only change through alfred's reviewed merge, never by push.
head=$(git symbolic-ref -q HEAD 2>/dev/null)
extra=""
if [ -f alfred-protected-branches ]; then extra=$(cat alfred-protected-branches); fi
status=0
while read old new ref; do
  for p in refs/heads/master refs/heads/main $head $extra; do
    if [ "$ref" = "$p" ]; then
      echo "alfred: pushing to $ref is not allowed — base branches change only through a reviewed merge" >&2
      status=1
    fi
  done
done
exit $status
`;

export interface RepoHubOpts {
  /** Root holding `<name>.git` bare repos. Default ~/.alfred/git */
  root?: string;
  /** SSH user for node-facing URLs. Default $USER. */
  sshUser?: string;
  /** SSH host for node-facing URLs. Default 'gx10-de9a'. */
  sshHost?: string;
  /** Test hook: URL a given node should use for a bare path. */
  urlForNode?: (node: string, barePath: string) => string;
}

export class RepoHub {
  readonly root: string;
  private readonly sshUser: string;
  private readonly sshHost: string;
  private readonly urlForNode: (node: string, barePath: string) => string;
  /** Serialize ensure() per repo name so concurrent calls don't race the clone. */
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(o: RepoHubOpts = {}) {
    this.root = o.root ?? join(homedir(), '.alfred', 'git');
    this.sshUser = o.sshUser ?? process.env.USER ?? process.env.LOGNAME ?? '';
    this.sshHost = o.sshHost ?? 'gx10-de9a';
    this.urlForNode = o.urlForNode ?? ((node, bare) => `ssh://${this.sshUser}@${this.sshHost}${bare}`);
    this.protectAll();
  }

  /** Install/refresh the base-branch pre-receive hook in one bare repo; `branches` are protected too. */
  protect(name: string, branches: string[] = []): void {
    const bare = this.barePath(name);
    if (!existsSync(bare)) return;
    const hooks = join(bare, 'hooks');
    mkdirSync(hooks, { recursive: true });
    const hook = join(hooks, 'pre-receive');
    const cur = existsSync(hook) ? readFileSync(hook, 'utf8') : null;
    if (cur !== PRE_RECEIVE_HOOK) {
      if (cur !== null && !cur.includes(HOOK_MARK)) {
        // Someone else's hook: keep it next to ours rather than silently dropping it.
        writeFileSync(join(hooks, 'pre-receive.before-alfred'), cur);
      }
      writeFileSync(hook, PRE_RECEIVE_HOOK);
    }
    chmodSync(hook, 0o755);
    const list = join(bare, 'alfred-protected-branches');
    const have = existsSync(list) ? readFileSync(list, 'utf8').split(/\s+/).filter(Boolean) : [];
    const want = [...new Set([...have, ...branches.filter((b) => /^[A-Za-z0-9._\/-]+$/.test(b) && !b.startsWith('-')).map((b) => `refs/heads/${b}`)])];
    if (want.join('\n') !== have.join('\n')) writeFileSync(list, want.join('\n') + '\n');
  }

  /** Startup: every existing `<name>.git` under the root gets the hook. Never throws. */
  protectAll(): void {
    try {
      if (!existsSync(this.root)) return;
      for (const d of readdirSync(this.root)) {
        if (!d.endsWith('.git')) continue;
        try {
          this.protect(d.slice(0, -4));
        } catch {
          /* one bad repo must not stop the rest */
        }
      }
    } catch {
      /* unreadable root: nothing to protect yet */
    }
  }

  /** Full sha of a branch in the hub, or null. */
  async headSha(name: string, branch: string): Promise<string | null> {
    const bare = this.barePath(name);
    if (!existsSync(bare) || !branch || branch.startsWith('-')) return null;
    try {
      return (await git(['--git-dir', bare, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])).trim() || null;
    } catch {
      return null;
    }
  }

  /** Absolute path of the bare repo for a name. */
  barePath(name: string): string {
    return join(this.root, `${name}.git`);
  }

  /**
   * Create the bare repo if missing. With `source` (a local checkout on the
   * Spark) push all of its branches and tags into the hub. Idempotent;
   * concurrent calls for the same name share one promise.
   */
  ensure(name: string, source?: string): Promise<string> {
    const prev = this.inflight.get(name) ?? Promise.resolve();
    const p = prev.then(
      () => this.doEnsure(name, source),
      () => this.doEnsure(name, source),
    );
    this.inflight.set(
      name,
      p.then(() => undefined, () => undefined),
    );
    return p;
  }

  private async doEnsure(name: string, source?: string): Promise<string> {
    const bare = this.barePath(name);
    if (!existsSync(bare)) {
      mkdirSync(this.root, { recursive: true });
      if (source && existsSync(source)) {
        // Clone --bare brings every branch + tag in one shot.
        // --no-local: force object transport so the result is a normal fetch/push pair.
        await git(['clone', '--bare', '--no-local', '--', source, bare]);
      } else {
        await git(['init', '--bare', '-q', '--', bare]);
      }
    } else if (source && existsSync(source)) {
      // Already there: sync branches/tags from the source. Fetched from the bare side (not pushed
      // into it), so the base-branch pre-receive hook doesn't apply to this trusted local sync.
      await git(['--git-dir', bare, 'fetch', '-q', '--force', '--', source, '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*']);
    }
    this.protect(name);
    return bare;
  }

  /** Clone URL for a machine: 'local' = the bare path; a node = urlForNode. */
  urlFor(name: string, node: string): string {
    const bare = this.barePath(name);
    if (node === 'local') return bare;
    return this.urlForNode(node, bare);
  }

  /** Branch names currently in the hub (empty when the hub doesn't exist yet). */
  async branches(name: string): Promise<string[]> {
    const bare = this.barePath(name);
    if (!existsSync(bare)) return [];
    const out = await git(['--git-dir', bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/']);
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  }
}
