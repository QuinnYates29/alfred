// Helper run inside a real worker thread (its own V8 isolate + OS thread) so the
// concurrency test in store-concurrency.test.ts exercises genuine parallel access
// to one sqlite file, not just sequential calls from a single event loop.
import { parentPort, workerData } from 'node:worker_threads';
import { openStore } from '../../../src/store.js';

const { dbPath, workerId, leaseMs } = workerData as {
  dbPath: string;
  workerId: string;
  leaseMs: number;
};

const store = openStore(dbPath);
const claimed: string[] = [];
let task = store.claimNext(workerId, { leaseMs });
while (task) {
  claimed.push(task.id);
  task = store.claimNext(workerId, { leaseMs });
}
store.close();
parentPort!.postMessage(claimed);
