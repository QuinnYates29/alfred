// Helper run inside a real worker thread: attempts a single claim() and reports
// whether it won, so the caller can race two of these against one contested task.
import { parentPort, workerData } from 'node:worker_threads';
import { openStore } from '../../../src/store.js';

const { dbPath, taskId, workerId, leaseMs } = workerData as {
  dbPath: string;
  taskId: string;
  workerId: string;
  leaseMs: number;
};

const store = openStore(dbPath);
const won = store.claim(taskId, workerId, leaseMs);
store.close();
parentPort!.postMessage(won);
