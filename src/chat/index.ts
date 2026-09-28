// P16 — chat with alfred: the conversational front door.
// Exposes the engine as `(module as any).chat` (the Slack module uses it).
import type { AlfredModule, ModuleDeps } from '../modules.js';
import { openChatStore } from './store.js';
import { ChatEngine } from './engine.js';
import { chatRouter } from './routes.js';

export function createChatModule(deps: ModuleDeps): AlfredModule {
  const cs = openChatStore(deps.store);
  const engine = new ChatEngine(deps, cs);
  const mod: AlfredModule = {
    name: 'chat',
    router: chatRouter(engine, cs),
    tools: [],
    // A turn that died with the previous process gets an "interrupted" note (never re-run).
    start: () => void engine.recoverInterrupted(),
    // In-flight turns are abandoned with the same note before the store closes.
    stop: () => engine.stop(),
  };
  (mod as any).chat = engine;
  return mod;
}
