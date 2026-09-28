// U1 — the Mac app's self-update: the Spark serves the packed app (app/dist/latest.json + the zip) behind
// the token and can rebuild it (`npm --prefix app run pack:mac`) on request. Only that one zip is ever
// served; no path comes from the request.
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type express from 'express';
import type { Request, Response } from 'express';
import { tail2, type OpsCtx } from './exec.js';

export const APP_ZIP = 'Alfred-mac-arm64.zip';
export const APP_LATEST = 'latest.json';
const BUILD_TIMEOUT_MS = 30 * 60_000;

export interface AppLatest {
  version: string;
  build: string;
  sha256: string;
  size: number;
  builtAt: string;
  commit: string;
}

/** latest.json from the dist dir, validated; null when there is no (usable) build. */
export function readLatest(distDir: string): AppLatest | null {
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(join(distDir, APP_LATEST), 'utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.build !== 'string' || !/^\d{8,20}$/.test(raw.build)) return null;
  if (typeof raw.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(raw.sha256)) return null;
  return {
    version: String(raw.version ?? ''),
    build: raw.build,
    sha256: raw.sha256,
    size: Number(raw.size) || 0,
    builtAt: String(raw.builtAt ?? ''),
    commit: String(raw.commit ?? ''),
  };
}

export interface AppBuildState {
  running: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  ok: boolean | null;
  output: string;
  by: string | null;
}

type Handler = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response) => void;
type LogOp = (action: string, target: string, ok: boolean, by?: unknown) => void;

export function registerAppRoutes(r: express.Router, ctx: OpsCtx, h: Handler, logOp: LogOp): void {
  const dist = ctx.appDistDir;
  const state: AppBuildState = { running: false, startedAt: null, finishedAt: null, ok: null, output: '', by: null };

  r.get(
    '/app/latest',
    h((_req, res) => {
      const latest = readLatest(dist);
      if (!latest) return res.status(404).json({ error: 'no build yet' });
      res.json(latest);
    }),
  );

  r.get(
    '/app/download',
    h((_req, res) => {
      const latest = readLatest(dist);
      const zip = join(dist, APP_ZIP);
      if (!latest || !existsSync(zip)) return res.status(404).json({ error: 'no build yet' });
      if (state.running) return res.status(409).json({ error: 'a build is running; try again when it is done' });
      const size = statSync(zip).size;
      res.status(200);
      res.setHeader('content-type', 'application/zip');
      res.setHeader('content-length', String(size));
      res.setHeader('x-sha256', latest.sha256);
      res.setHeader('x-build', latest.build);
      res.setHeader('content-disposition', `attachment; filename="${APP_ZIP}"`);
      res.setHeader('cache-control', 'no-store');
      const s = createReadStream(zip);
      s.on('error', () => res.destroy());
      s.pipe(res);
    }),
  );

  r.get('/ops/app/build', h((_req, res) => res.json({ ...state, latest: readLatest(dist) })));

  r.post(
    '/ops/app/build',
    h((req, res) => {
      const body = req.body ?? {};
      if (body.confirm !== true) return res.status(400).json({ error: 'confirm required' });
      if (state.running) return res.status(409).json({ error: 'a Mac app build is already running', startedAt: state.startedAt });
      const by = typeof body.by === 'string' ? body.by.slice(0, 40) : 'api';
      Object.assign(state, { running: true, startedAt: Date.now(), finishedAt: null, ok: null, output: '', by });
      res.status(202).json({ ok: true, started: true, startedAt: state.startedAt });
      void ctx
        .exec('npm', ['--prefix', 'app', 'run', 'pack:mac'], { cwd: ctx.repoRoot, timeoutMs: BUILD_TIMEOUT_MS })
        .catch((e: any) => ({ code: 1, stdout: '', stderr: e?.message ?? String(e) }))
        .then((out) => {
          const ok = out.code === 0;
          const output = tail2(`${out.stdout}${out.stderr}`);
          Object.assign(state, { running: false, finishedAt: Date.now(), ok, output });
          try {
            writeFileSync(join(dist, 'build.log'), output);
          } catch {
            /* dist may not exist when the build failed early */
          }
          const latest = readLatest(dist);
          logOp('app.build', latest ? `${latest.version} ${latest.build} ${latest.commit}` : 'app', ok, by);
        });
    }),
  );
}
