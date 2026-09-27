// P14 — Ops & stats API: services, Qwen server, logs, config files, dispatch, repos, stats.
import type { AlfredModule, ModuleDeps } from '../modules.js';
import { buildOpsRouter } from './routes.js';

export function createOpsModule(deps: ModuleDeps): AlfredModule {
  return { name: 'ops', router: buildOpsRouter(deps) };
}
