// P14 — the ops router. Paths are relative; app.ts mounts at /api/v1 and /api.
import { existsSync, readFileSync, statSync } from 'node:fs';
import express, { type Request, type Response } from 'express';
import type { ModuleDeps } from '../modules.js';
import { makeCtx, tail2, type OpsCtx } from './exec.js';
import { getStats, getHistory } from './stats.js';
import { listServices, SERVICES } from './services.js';
import { parseQwenExtra, parseQwenSetting, qwenHealth, qwenRunningCmdline, QWEN_LIMITS, QWEN_PRESETS, readQwenEnv, runQwenctl } from './qwen.js';
import { applyPermissions } from './permissions.js';
import { getLogs } from './logs.js';
import { CONFIG_PATH_RE, listConfigFiles, putConfigFile, redactConfigContent, resolveConfigPath } from './config-files.js';
import { envRedactor } from '../redact.js';
import { getDispatch, launchDispatch, listDispatch } from './dispatch.js';
import { createRepo, listReposWithBranches } from './repos.js';
import { registerAppRoutes } from './app-updates.js';

function err(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

const msgOf = (e: any) => e?.message ?? String(e);

/** express 5 does not catch async rejections for us. Handlers may return res.json(...) or nothing. */
function h(fn: (req: Request, res: Response) => unknown) {
  return (req: Request, res: Response): void => {
    try {
      const out = fn(req, res) as unknown;
      if (out && typeof (out as Promise<unknown>).then === 'function') {
        void (out as Promise<unknown>).catch((e: any) => {
          if (!res.headersSent) err(res, e?.status ?? 500, msgOf(e));
        });
      }
    } catch (e: any) {
      if (!res.headersSent) err(res, e?.status ?? 500, msgOf(e));
    }
  };
}

export function buildOpsRouter(deps: ModuleDeps): express.Router {
  const r = express.Router();
  const ctx: OpsCtx = makeCtx(deps);
  const store = deps.store;

  const logOp = (action: string, target: string, ok: boolean, by?: unknown) => {
    try {
      store.appendEvent('', null, 'ops', { action, target, ok, by: by ?? 'api' });
    } catch {
      /* event log must never break the response */
    }
  };

  // ---- §2 stats ----
  r.get('/stats', h(async (_req, res) => res.json(await getStats(store, ctx))));

  r.get(
    '/stats/history',
    h((req, res) => {
      let hours = Number(req.query.hours ?? 24);
      let bucket = Number(req.query.bucket ?? 3600);
      if (!Number.isFinite(hours) || hours < 1) hours = 24;
      hours = Math.min(hours, 168);
      if (!Number.isFinite(bucket) || bucket < 60) bucket = 3600;
      res.json(getHistory(store, hours, bucket));
    }),
  );

  // ---- §3 services ----
  r.get('/ops/services', h(async (_req, res) => res.json(await listServices(ctx, deps.deckState?.url))));

  r.post(
    '/ops/services/:name/:action',
    h(async (req, res) => {
      const body = req.body ?? {};
      if (body.confirm !== true) return err(res, 400, 'confirm required');
      const name = String(req.params.name);
      const action = String(req.params.action);
      const def = SERVICES.find((s) => s.name === name) ?? (name === 'deck' ? { name: 'deck', unit: null, controllable: [] } : undefined);
      if (!def) return err(res, 404, `unknown service: ${name}`);
      if (!def.controllable.includes(action)) return err(res, 400, `action not allowed for ${name}: ${action}`);
      const by = body.by;
      if (name === 'alfred' && action === 'restart') {
        logOp('alfred.restart', def.unit ?? name, true, by);
        res.status(202).json({ ok: true, restarting: true });
        ctx.spawnDetached('systemctl', ['--user', 'restart', 'alfred.service'], { delayMs: 500 });
        return;
      }
      const running = deps.scheduler?.running() ?? [];
      if ((action === 'stop' || action === 'restart') && running.length && !body.force) {
        logOp(`qwen-server.${action}`, def.unit ?? name, false, by);
        return res.status(409).json({ error: 'tasks are running on the model', running });
      }
      const out = await ctx.exec('systemctl', ['--user', action, def.unit!], { timeoutMs: 120_000 });
      const ok = out.code === 0;
      logOp(`${name}.${action}`, def.unit ?? name, ok, by);
      res.status(ok ? 200 : 500).json({ ok, output: tail2(`${out.stdout}${out.stderr}`) });
    }),
  );

  // ---- §4 qwen ----
  r.get(
    '/ops/qwen',
    h(async (_req, res) => {
      const [health, running] = await Promise.all([qwenHealth(ctx), qwenRunningCmdline(ctx)]);
      const env = readQwenEnv(ctx.qwenEnvPath);
      let extraRows: { flag: string; value: string }[] | null = null;
      try {
        extraRows = parseQwenExtra(env.QWEN_EXTRA ?? '');
      } catch {
        /* hand-edited into something we won't round-trip: the UI falls back to raw text */
      }
      res.json({ env, health, presets: QWEN_PRESETS, limits: QWEN_LIMITS, url: ctx.qwenUrl, running, extraRows });
    }),
  );

  r.post(
    '/ops/qwen',
    h(async (req, res) => {
      const body = req.body ?? {};
      if (body.confirm !== true) return err(res, 400, 'confirm required');
      const running = deps.scheduler?.running() ?? [];
      if (running.length && !body.force) {
        logOp('qwen.set', 'qwen-server', false, body.by);
        return res.status(409).json({ error: 'tasks are running on the model', running });
      }
      let setting;
      try {
        setting = parseQwenSetting(body);
      } catch (e: any) {
        return err(res, 400, msgOf(e));
      }
      const out = await runQwenctl(ctx, setting.verb, setting.value);
      logOp(`qwen.${setting.verb}`, 'qwen-server', out.ok, body.by);
      res.status(out.ok ? 200 : 500).json(out);
    }),
  );

  // ---- §5 logs ----
  r.get(
    '/ops/logs/:name',
    h(async (req, res) => {
      const lines = Number(req.query.lines ?? 200);
      if (!Number.isInteger(lines) || lines < 1 || lines > 2000) return err(res, 400, 'lines must be 1..2000');
      const out = await getLogs(ctx, String(req.params.name), lines);
      if ('error' in out) return err(res, out.status, out.error);
      res.json(out);
    }),
  );

  // ---- §6 config files ----
  r.get('/ops/config', h((_req, res) => res.json(listConfigFiles(deps))));

  r.get(
    '/ops/config/file',
    h((req, res) => {
      const path = String(req.query.path ?? '');
      if (!CONFIG_PATH_RE.test(path)) return err(res, 400, `invalid path: ${path}`);
      const abs = resolveConfigPath(deps, path)!;
      if (!existsSync(abs)) return err(res, 404, `no such file: ${path}`);
      // Literal secrets (and env secret values) are masked; a PUT with a mask is refused.
      const { content, redacted } = redactConfigContent(readFileSync(abs, 'utf8'), envRedactor(deps.env ?? {}));
      res.json({ path, content, mtime: Math.floor(statSync(abs).mtimeMs), ...(redacted ? { redacted: true } : {}) });
    }),
  );

  r.put(
    '/ops/config/file',
    h((req, res) => {
      const body = req.body ?? {};
      if (body.confirm !== true) return err(res, 400, 'confirm required');
      const path = String(body.path ?? '');
      if (!CONFIG_PATH_RE.test(path)) return err(res, 400, `invalid path: ${path}`);
      const content = typeof body.content === 'string' ? body.content : null;
      if (content === null) return err(res, 400, 'content is required');
      try {
        const out = putConfigFile(deps, ctx.backupDir, path, content, body.mtime === undefined ? undefined : Number(body.mtime));
        logOp('config.put', path, true, body.by);
        res.json(out);
      } catch (e: any) {
        logOp('config.put', path, false, body.by);
        err(res, e?.status ?? 400, msgOf(e));
      }
    }),
  );

  // Permissions matrix: persona `tools:` lists + per-model `deny:` lists, validated, backed up, reloaded.
  r.post(
    '/ops/permissions',
    h((req, res) => {
      const body = req.body ?? {};
      if (body.confirm !== true) return err(res, 400, 'confirm required');
      try {
        const out = applyPermissions(deps, ctx.backupDir, body);
        logOp('permissions.set', out.written.join(',') || '-', true, body.by);
        res.json(out);
      } catch (e: any) {
        logOp('permissions.set', '-', false, body.by);
        err(res, e?.status ?? 400, msgOf(e));
      }
    }),
  );

  // ---- §7 build harness ----
  r.get('/ops/dispatch', h((_req, res) => res.json(listDispatch(ctx.dispatchDir))));

  r.get(
    '/ops/dispatch/:name',
    h((req, res) => {
      if (!/^[A-Za-z0-9_-]+$/.test(String(req.params.name))) return err(res, 400, 'name must match ^[A-Za-z0-9_-]+$');
      const out = getDispatch(ctx.dispatchDir, String(req.params.name));
      if (!out) return err(res, 404, 'no such dispatch job');
      res.json(out);
    }),
  );

  r.post(
    '/ops/dispatch',
    h((req, res) => {
      const body = req.body ?? {};
      if (body.confirm !== true) return err(res, 400, 'confirm required');
      const out = launchDispatch(ctx, body);
      if ('error' in out) {
        logOp('dispatch.start', String(body.name ?? ''), false, body.by);
        return err(res, out.status, out.error);
      }
      logOp('dispatch.start', out.name, true, body.by);
      res.status(202).json({ ok: true, name: out.name });
    }),
  );

  // ---- §8 repos ----
  r.get('/ops/repos', h(async (_req, res) => res.json(await listReposWithBranches(deps))));

  r.post(
    '/ops/repos',
    h(async (req, res) => {
      const body = req.body ?? {};
      if (body.confirm !== true) return err(res, 400, 'confirm required');
      try {
        const repo = await createRepo(deps, body);
        logOp('repo.upsert', repo.name, true, body.by);
        res.status(201).json(repo);
      } catch (e: any) {
        logOp('repo.upsert', String(body.name ?? ''), false, body.by);
        err(res, e?.status ?? 400, msgOf(e));
      }
    }),
  );

  // ---- §9 web rebuild ----
  r.post(
    '/ops/alfred/build-web',
    h(async (req, res) => {
      const body = req.body ?? {};
      if (body.confirm !== true) return err(res, 400, 'confirm required');
      const out = await ctx.exec('npm', ['run', 'build:web'], { cwd: ctx.repoRoot, timeoutMs: 600_000 });
      const ok = out.code === 0;
      logOp('alfred.build-web', ctx.repoRoot, ok, body.by);
      res.status(ok ? 200 : 500).json({ ok, output: tail2(`${out.stdout}${out.stderr}`) });
    }),
  );

  // ---- U1 Mac app: latest build, download, rebuild ----
  registerAppRoutes(r, ctx, h, logOp);

  return r;
}
