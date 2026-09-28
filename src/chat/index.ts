// P16 — chat with alfred: the conversational front door.
// Exposes the engine as `(module as any).chat` (the Slack module uses it).
import type { AlfredModule, ModuleDeps } from '../modules.js';
import { openChatStore } from './store.js';
import { ChatEngine } from './engine.js';
import { chatRouter } from './routes.js';
import { startGoalDataset } from '../datasetGoals.js';

export function createChatModule(deps: ModuleDeps): AlfredModule {
  const cs = openChatStore(deps.store);
  const engine = new ChatEngine(deps, cs);
  let unsubGoals: (() => void) | null = null;
  const mod: AlfredModule = {
    name: 'chat',
    router: chatRouter(engine, cs, deps.env),
    tools: [],
    // A turn that died with the previous process gets an "interrupted" note (never re-run).
    // Finished goals are mirrored into the dataset (except goals marked private).
    start: () => {
      void engine.recoverInterrupted();
      unsubGoals ??= startGoalDataset(deps);
    },
    // In-flight turns are abandoned with the same note before the store closes.
    stop: () => {
      unsubGoals?.();
      unsubGoals = null;
      engine.stop();
    },
  };
  (mod as any).chat = engine;
  return mod;
}
