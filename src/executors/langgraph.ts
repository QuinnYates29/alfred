// P2 §3 — `langgraph_code`: runs the constrained LangGraph coder sidecar.
// P9: on a node workspace the sidecar still runs here (Python + Qwen live on the
// Spark) but reaches the files through a one-shot localhost "file bridge" backed
// by ctx.backend.
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve as presolve, sep } from 'node:path';
import type { Tool, ToolContext, ToolResult, WorkspaceBackend } from '../runtime/contract.js';
import type { ModelRegistry } from '../models.js';
import { sandboxedCommand } from '../sandbox.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface SidecarResult {
  ok: boolean;
  iterations: number;
  testOutput: string;
  filesChanged: string[];
}

/**
 * P9: one-shot localhost HTTP bridge so the (Spark-local) sidecar can read /
 * write / list / exec through a node backend. Paths are checked against the
 * workspace here as well; the node enforces its own roots.
 */
export async function startBridge(ctx: ToolContext): Promise<{ url: string; secret: string; close: () => void }> {
  const backend: WorkspaceBackend = ctx.backend!;
  // Any local process can reach 127.0.0.1: require a per-run bearer secret (handed to
  // the sidecar on stdin, never in env/argv), a JSON content-type (no simple-request
  // CSRF from a browser) and our exact Host (no DNS rebinding).
  const secret = randomBytes(32).toString('hex');
  let expectedHost = '';
  const server = createServer((req, res) => {
    const deny = (code: number, error: string) => {
      res.statusCode = code;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: false, error }));
    };
    const auth = String(req.headers.authorization ?? '');
    const want = Buffer.from(`Bearer ${secret}`);
    const got = Buffer.from(auth);
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      req.resume();
      return deny(401, 'unauthorized');
    }
    if (String(req.headers.host ?? '') !== expectedHost) {
      req.resume();
      return deny(403, 'bad host');
    }
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) {
      req.resume();
      return deny(415, 'content-type must be application/json');
    }
    let body = '';
    req.on('data', (c: Buffer) => (body += c));
    req.on('end', () => {
      void (async () => {
        const reply = (v: unknown) => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(v));
        };
        try {
          const b = JSON.parse(body || '{}');
          const inWs = (p: unknown): string | null => {
            if (typeof p !== 'string') return null;
            const abs = presolve(ctx.workspace, p);
            return abs === ctx.workspace || abs.startsWith(ctx.workspace + sep) ? abs : null;
          };
          if (req.method === 'POST' && (req.url ?? '').split('?')[0] === '/fs') {
            const abs = inWs(b.path);
            if (!abs) return reply({ ok: false, error: 'path escapes the workspace' });
            const op = String(b.op ?? '');
            if (op === 'read') return reply({ ok: true, text: await backend.readFile(abs) });
            if (op === 'write') {
              await backend.writeFile(abs, String(b.content ?? ''));
              return reply({ ok: true });
            }
            if (op === 'list') return reply({ ok: true, entries: await backend.listDir(abs) });
            return reply({ ok: false, error: `unknown fs op: ${op}` });
          }
          if (req.method === 'POST' && (req.url ?? '').split('?')[0] === '/exec') {
            const r = await backend.exec(String(b.cmd ?? ''), {
              cwd: ctx.workspace,
              workspace: ctx.workspace,
              timeoutMs: Number(b.timeoutMs) > 0 ? Number(b.timeoutMs) : 600_000,
              ...(ctx.signal ? { signal: ctx.signal } : {}),
            });
            return reply({ ok: true, ...r });
          }
          reply({ ok: false, error: 'not found' });
        } catch (e: any) {
          reply({ ok: false, error: e?.message ?? String(e) });
        }
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  expectedHost = `127.0.0.1:${port}`;
  return { url: `http://127.0.0.1:${port}`, secret, close: () => server.close() };
}

export type SidecarRun =
  | { ok: true; result: any; tail: string }
  | { ok: false; error: string; tail: string };

/**
 * Run `python -m langgraph_coder` sandboxed (it, and the test command it runs, see only `workspace`, the
 * toolchain allowlist and the sidecar's own code; env scrubbed), in its own process group (abort/timeout
 * SIGKILL the group). `request` goes on stdin; JSON `{progress}` lines on stderr are reported; the result
 * is the last stdout line parsed as JSON. Shared by langgraph_code and the peer review (ALF-7).
 */
export function runSidecar(o: {
  python: string;
  workspace: string;
  request: Record<string, any>;
  timeoutMs: number;
  signal?: AbortSignal;
  onProgress?: (msg: string) => void;
}): Promise<SidecarRun> {
  return new Promise<SidecarRun>((resolve) => {
    const sc = sandboxedCommand(o.python, ['-m', 'langgraph_coder'], {
      workspace: o.workspace,
      // + the venv root (python is <venv>/bin/python; the venv may be a symlink elsewhere)
      readonly: [join(REPO_ROOT, 'sidecar'), dirname(dirname(o.python))],
      extraEnv: { PYTHONPATH: join(REPO_ROOT, 'sidecar') },
    });
    const child = spawn(sc.file, sc.args, { cwd: sc.cwd, env: sc.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    child.stdin.on('error', () => { /* child died early: 'close' reports it */ });
    child.stdin.end(JSON.stringify(o.request));

    let stdout = '';
    let stderrTail = '';
    let errBuf = '';
    let settled = false;
    const tail = () => (stderrTail + errBuf).slice(-2000);
    const kill = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ } };
    const done = (r: SidecarRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };
    const timer = setTimeout(() => { kill(); done({ ok: false, error: 'timeout', tail: tail() }); }, o.timeoutMs);
    const onAbort = () => { kill(); done({ ok: false, error: 'cancelled', tail: tail() }); };
    if (o.signal?.aborted) onAbort();
    else o.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => {
      errBuf += d.toString();
      let nl: number;
      while ((nl = errBuf.indexOf('\n')) >= 0) {
        const line = errBuf.slice(0, nl).trim();
        errBuf = errBuf.slice(nl + 1);
        if (!line) continue;
        stderrTail = (stderrTail + line + '\n').slice(-8000);
        try {
          const p = JSON.parse(line);
          if (typeof p?.progress === 'string') o.onProgress?.(p.progress);
        } catch { /* non-JSON stderr is allowed and ignored */ }
      }
    });
    child.on('error', (e) => done({ ok: false, error: `failed to start sidecar (${o.python}): ${e.message}`, tail: tail() }));
    child.on('close', (code) => {
      const last = stdout.trimEnd().split('\n').filter(Boolean).pop() ?? '';
      try {
        const p = JSON.parse(last);
        if (p && typeof p === 'object') return done({ ok: true, result: p, tail: tail() });
      } catch { /* fall through */ }
      done({ ok: false, error: `sidecar produced no final JSON (exit=${code})`, tail: tail() });
    });
  });
}

export function langgraphTool(o?: {
  python?: string; /* <repo>/sidecar/.venv/bin/python */
  baseUrl?: string;
  model?: string;
  /** P7: when present, the 'coder' role's endpoint is resolved per call. */
  models?: ModelRegistry;
  defaultTimeoutMin?: number; /* 45 */
}): Tool {
  const python = o?.python ?? join(REPO_ROOT, 'sidecar', '.venv', 'bin', 'python');
  const defaultTimeoutMin = o?.defaultTimeoutMin ?? 45;

  return {
    kind: 'exec',
    schema: {
      name: 'langgraph_code',
      description:
        'Constrained coding agent (LangGraph sidecar): edits files in the workspace with ' +
        'read_file/write_file/list_dir only (no shell), then runs this task\'s acceptance ' +
        'checks; retries with the failure output until they pass or maxIterations is reached.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'What to implement/fix in the workspace.' },
          maxIterations: { type: 'integer', description: 'Max test runs (default 6).' },
        },
        required: ['task'],
      },
    },
    async run(args: any, ctx: ToolContext): Promise<ToolResult> {
      const task = String(args?.task ?? '');
      const maxIterations = Math.max(1, Math.floor(Number(args?.maxIterations ?? 6)) || 6);
      const cmds = (ctx.acceptance ?? []).map(c => c.cmd).filter(Boolean);
      if (cmds.length === 0) return Promise.resolve({ ok: false, output: 'no acceptance checks to test against' });
      const testCmd = cmds.join(' && ');
      const timeoutMs = defaultTimeoutMin * 60_000;
      const spec = o?.models?.resolve('coder');
      const baseUrl = spec?.baseUrl ?? o?.baseUrl ?? 'http://127.0.0.1:1110';
      const model = spec?.model ?? o?.model ?? 'qwen3.8-flash-next';

      // P9: node workspace → the sidecar reaches the files through the bridge.
      const remote = !!ctx.backend && ctx.backend.node !== 'local';
      let bridge: { url: string; secret: string; close: () => void } | undefined;
      let scratch: string | undefined; // remote: the sidecar's local sandbox dir (the files live on the node)
      if (remote) {
        try {
          bridge = await startBridge(ctx);
        } catch (e: any) {
          return { ok: false, output: `file bridge failed to start: ${e?.message ?? e}` };
        }
      }
      try {
        if (remote) scratch = mkdtempSync(join(tmpdir(), 'alfred-langgraph-'));
        const run = await runSidecar({
          python,
          workspace: scratch ?? ctx.workspace,
          request: {
            task, workspace: ctx.workspace, testCmd, maxIterations, baseUrl, model,
            ...(bridge ? { bridgeUrl: bridge.url, bridgeToken: bridge.secret } : {}),
          },
          timeoutMs,
          signal: ctx.signal,
          onProgress: (m) => ctx.progress('langgraph: ' + m),
        });
        if (!run.ok) return { ok: false, output: run.error === 'timeout' ? `langgraph_code timed out after ${defaultTimeoutMin} min\n${run.tail}` : run.error === 'cancelled' ? 'cancelled' : `${run.error}\n${run.tail}` };
        const p = run.result;
        if (typeof p?.ok !== 'boolean') return { ok: false, output: `sidecar produced no final JSON\n${run.tail}` };
        const r: SidecarResult = {
          ok: p.ok,
          iterations: Number(p.iterations) || 0,
          testOutput: String(p.testOutput ?? ''),
          filesChanged: Array.isArray(p.filesChanged) ? p.filesChanged.map(String) : [],
        };
        const output = [
          `ok=${r.ok} iterations=${r.iterations}`,
          `filesChanged: ${r.filesChanged.length ? r.filesChanged.join(', ') : '(none)'}`,
          `testOutput:\n${r.testOutput}`.slice(0, 5000),
        ].join('\n').slice(0, 8000);
        return { ok: r.ok, output };
      } finally {
        bridge?.close();
        if (scratch) {
          try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
        }
      }
    },
  };
}
