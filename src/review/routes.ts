// P15 §3 — the review routes. Mounted at /api/v1 + /api behind the token.
import { Router } from 'express';
import type { ModuleDeps } from '../modules.js';
import { getChanges, getFileDiff } from './changes.js';
import { mergeGoal, discardGoal, HttpError } from './land.js';
import { transcriptFor } from './transcript.js';
import { resolveWorkspace, listWorkspace, readWorkspaceFile } from './files.js';

function q(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

export function reviewRouter(deps: ModuleDeps): Router {
  const r = Router();
  const store = deps.store;
  const findGoal = (idOrSlug: string) =>
    store.getGoal(idOrSlug) ?? store.listGoals().find((g) => g.slug === idOrSlug);

  const h =
    (fn: (req: any, res: any) => Promise<void>) =>
    (req: any, res: any) => {
      fn(req, res).catch((e: any) => {
        if (res.headersSent) return;
        if (e instanceof HttpError) res.status(e.status).json({ error: e.message, ...e.extra });
        else res.status(500).json({ error: e?.message ?? String(e) });
      });
    };

  r.get(
    '/goals/:id/changes',
    h(async (req, res) => {
      const goal = findGoal(req.params.id);
      if (!goal) return res.status(404).json({ error: 'no such goal' });
      const branch = q(req.query.branch);
      const file = q(req.query.file);
      if (file) return res.json(await getFileDiff(store, deps.repoHub, goal, file, branch));
      res.json(await getChanges(store, deps.repoHub, goal, branch));
    }),
  );

  r.post(
    '/goals/:id/merge',
    h(async (req, res) => {
      const goal = findGoal(req.params.id);
      if (!goal) return res.status(404).json({ error: 'no such goal' });
      const b = req.body ?? {};
      if (b.confirm !== true) return res.status(400).json({ error: 'confirm: true required' });
      const out = await mergeGoal(store, deps.repoHub, goal, {
        branch: q(b.branch),
        into: q(b.into),
        strategy: b.strategy === 'squash' ? 'squash' : 'merge',
        message: q(b.message),
        deleteBranch: b.deleteBranch !== false,
        // The commit + base the reviewer saw (Changes view / approved deploy): merged exactly, or refused.
        sha: q(b.sha),
        baseSha: q(b.baseSha),
      });
      res.json(out);
    }),
  );

  r.post(
    '/goals/:id/discard',
    h(async (req, res) => {
      const goal = findGoal(req.params.id);
      if (!goal) return res.status(404).json({ error: 'no such goal' });
      const b = req.body ?? {};
      if (b.confirm !== true) return res.status(400).json({ error: 'confirm: true required' });
      res.json(await discardGoal(store, deps.repoHub, deps.workRoot, goal, q(b.branch)));
    }),
  );

  r.get(
    '/tasks/:id/transcript',
    h(async (req, res) => {
      if (!store.getTask(req.params.id)) return res.status(404).json({ error: 'no such task' });
      res.json(transcriptFor(store, req.params.id));
    }),
  );

  r.get(
    '/goals/:id/files',
    h(async (req, res) => {
      const goal = findGoal(req.params.id);
      if (!goal) return res.status(404).json({ error: 'no such goal' });
      const ws = resolveWorkspace(store, goal.id, q(req.query.task));
      res.json(await listWorkspace(deps.nodes, ws, q(req.query.path) ?? '.'));
    }),
  );

  r.get(
    '/goals/:id/file',
    h(async (req, res) => {
      const goal = findGoal(req.params.id);
      if (!goal) return res.status(404).json({ error: 'no such goal' });
      const ws = resolveWorkspace(store, goal.id, q(req.query.task));
      res.json(await readWorkspaceFile(deps.nodes, ws, q(req.query.path) ?? '.'));
    }),
  );

  return r;
}
