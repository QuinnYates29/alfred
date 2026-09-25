// P10 §1 — the repo hub on the Spark. One bare repo per project under
// ~/.alfred/git; every Alfred workspace (Spark or node) pushes to and clones
// from it, so work is connected between machines without GitHub.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
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
        await git(['clone', '--bare', '--no-local', source, bare]);
      } else {
        await git(['init', '--bare', '-q', bare]);
      }
    } else if (source && existsSync(source)) {
      // Already there: sync branches/tags from the source.
      await git(['-C', source, 'push', '--force', bare, '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*']);
    }
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
