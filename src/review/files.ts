// P15 §6 — browsing a goal's task workspaces (local fs or a node backend).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Store } from '../store.js';
import type { NodeHub } from '../node/hub.js';
import { NodeOfflineError } from '../runtime/contract.js';
import { HttpError } from './land.js';

export const FILE_CAP = 512_000;

export interface WorkspaceRef {
  workspace: string;
  node: string;
}

/** The workspace of `?task=`, else the goal's root task (first task without a parent). */
export function resolveWorkspace(store: Store, goalId: string, taskId?: string): WorkspaceRef {
  const events = store.events(goalId);
  const pick = (tid: string): WorkspaceRef | null => {
    let found: WorkspaceRef | null = null;
    for (const e of events) {
      if (e.kind === 'workspace' && e.taskId === tid && typeof e.data?.path === 'string') {
        found = { workspace: e.data.path, node: String(e.data.node ?? 'local') };
      }
    }
    return found;
  };
  if (taskId) {
    const ws = pick(taskId);
    if (!ws) throw new HttpError(404, 'no workspace yet');
    return ws;
  }
  const tasks = store.listTasks(goalId);
  const rootTask = tasks.find((t) => !t.parentTaskId) ?? tasks[0];
  const ws = rootTask ? pick(rootTask.id) : null;
  if (!ws) throw new HttpError(404, 'no workspace yet');
  return ws;
}

/** Join a relative path under the workspace; anything escaping it is a 400. */
export function safeJoin(workspace: string, rel: string): string {
  const r = rel ?? '.';
  if (path.isAbsolute(r)) throw new HttpError(400, 'path must be relative to the workspace');
  const joined = path.resolve(workspace, r);
  const ws = path.resolve(workspace);
  if (joined !== ws && !joined.startsWith(ws + path.sep)) throw new HttpError(400, 'path escapes the workspace');
  return joined;
}

function wrapOffline<T>(node: string, p: Promise<T>): Promise<T> {
  return p.catch((e: any) => {
    if (e instanceof NodeOfflineError) throw new HttpError(503, `node ${node} offline`);
    throw e;
  });
}

export async function listWorkspace(
  nodes: NodeHub,
  ws: WorkspaceRef,
  rel: string,
): Promise<{ workspace: string; node: string; path: string; entries: { name: string; dir: boolean }[] }> {
  const abs = safeJoin(ws.workspace, rel);
  let entries: { name: string; dir: boolean }[];
  if (ws.node === 'local') {
    entries = (await fs.readdir(abs, { withFileTypes: true }).catch((e: any) => {
      throw new HttpError(e?.code === 'ENOENT' ? 404 : 500, e?.message ?? String(e));
    })).map((d) => ({ name: d.name, dir: d.isDirectory() }));
  } else {
    entries = await wrapOffline(ws.node, nodes.backend(ws.node).listDir(abs));
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return { workspace: ws.workspace, node: ws.node, path: rel || '.', entries };
}

export async function readWorkspaceFile(
  nodes: NodeHub,
  ws: WorkspaceRef,
  rel: string,
): Promise<{ workspace: string; node: string; path: string; content: string; size: number; truncated: boolean }> {
  const abs = safeJoin(ws.workspace, rel);
  let raw: string;
  if (ws.node === 'local') {
    raw = await fs.readFile(abs, 'utf8').catch((e: any) => {
      throw new HttpError(e?.code === 'ENOENT' ? 404 : 500, e?.message ?? String(e));
    });
  } else {
    raw = await wrapOffline(ws.node, nodes.backend(ws.node).readFile(abs));
  }
  return {
    workspace: ws.workspace,
    node: ws.node,
    path: rel,
    content: raw.slice(0, FILE_CAP),
    size: Buffer.byteLength(raw),
    truncated: raw.length > FILE_CAP,
  };
}
