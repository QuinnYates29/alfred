// P15 — review module: land/discard goal branches, read transcripts, browse workspaces.
import type { AlfredModule, ModuleDeps } from '../modules.js';
import { reviewRouter } from './routes.js';

export function createReviewModule(deps: ModuleDeps): AlfredModule {
  return { name: 'review', router: reviewRouter(deps) };
}
