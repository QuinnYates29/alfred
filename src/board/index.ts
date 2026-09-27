// P13 board module — wires data layer, HTTP routes, agent tool and goal sync.
import type { AlfredModule, ModuleDeps } from '../modules.js';
import { openBoard } from './board.js';
import { boardRouter } from './routes.js';
import { boardTool } from './tool.js';
import { startBoardSync } from './sync.js';

export function createBoardModule(deps: ModuleDeps): AlfredModule {
  const board = openBoard(deps.store);
  let stopSync: (() => void) | undefined;
  const mod: AlfredModule = {
    name: 'board',
    router: boardRouter({
      store: deps.store,
      board,
      personas: () => deps.personas ?? new Map(),
    }),
    tools: [boardTool(() => board)],
    start() {
      stopSync = startBoardSync(deps.store, board);
    },
    stop() {
      stopSync?.();
      stopSync = undefined;
    },
  };
  (mod as any).board = board;
  return mod;
}
