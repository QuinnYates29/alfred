// P15 — review module: land/discard goal branches, read transcripts, browse workspaces.
import type { AlfredModule, ModuleDeps } from '../modules.js';
import { reviewRouter } from './routes.js';
import { runPeerReview, PEER_REVIEW_DONE } from './peer.js';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

export function createReviewModule(deps: ModuleDeps): AlfredModule {
  // Review clones a restart interrupted (no review runs at boot), and goals it left `active`.
  rmSync(join(deps.workRoot, '.peer-review'), { recursive: true, force: true });
  for (const g of deps.store.listGoals()) if (g.status === 'active') deps.store.rollupGoalStatus(g.id, 'interrupted peer review');
  // ALF-7: a goal that opted into peer review gets one when it is done.
  deps.store.onEvent((e) => {
    // (not the done that a finished review rolls the goal back to — that would review forever)
    // …nor a status someone set (`by`: Quinn's override, "done by review").
    if (e.kind !== 'goal_status' || e.data?.status !== 'done' || e.data?.reason === PEER_REVIEW_DONE || e.data?.by || !e.goalId) return;
    const goal = deps.store.getGoal(e.goalId);
    if (goal?.meta?.peerReview !== true) return;
    setImmediate(() => runPeerReview(deps, goal).catch((err) => console.error(`[peer-review] ${goal.slug}: ${err?.message ?? err}`)));
  });
  return { name: 'review', router: reviewRouter(deps) };
}
