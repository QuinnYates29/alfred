// P15 — review module: land/discard goal branches, read transcripts, browse workspaces.
import type { AlfredModule, ModuleDeps } from '../modules.js';
import { reviewRouter } from './routes.js';
import { runPeerReview } from './peer.js';

export function createReviewModule(deps: ModuleDeps): AlfredModule {
  // ALF-7: a goal that opted into peer review gets one when it is done.
  deps.store.onEvent((e) => {
    if (e.kind !== 'goal_status' || e.data?.status !== 'done' || !e.goalId) return;
    const goal = deps.store.getGoal(e.goalId);
    if (goal?.meta?.peerReview !== true) return;
    setImmediate(() => runPeerReview(deps, goal).catch((err) => console.error(`[peer-review] ${goal.slug}: ${err?.message ?? err}`)));
  });
  return { name: 'review', router: reviewRouter(deps) };
}
