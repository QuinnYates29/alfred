// vitest globalSetup: on a headless machine the Electron acceptance suites (p17/p18) need a
// display. Start our OWN Xvfb on a free display number and export DISPLAY for the run.
// Safety (W1 lesson): we only ever touch the display number we picked — never another
// server's socket or lock file. If DISPLAY is already set, or Xvfb is unavailable, this is a
// no-op and display tests fail exactly as before.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';

let proc: ChildProcess | null = null;
let ourDisplay: number | null = null;

const socketOf = (n: number) => `/tmp/.X11-unix/X${n}`;

export default async function setup(): Promise<void> {
  if (process.env.DISPLAY) return;
  let num = -1;
  for (let n = 99; n < 120; n++) {
    if (!existsSync(`/tmp/.X${n}-lock`) && !existsSync(socketOf(n))) {
      num = n;
      break;
    }
  }
  if (num < 0) return; // nothing free: leave DISPLAY unset (tests behave as without this file)
  try {
    proc = spawn('Xvfb', [`:${num}`, '-screen', '0', '1440x900x24', '-nolock'], { stdio: 'ignore' });
  } catch {
    proc = null;
    return;
  }
  proc.on('error', () => {
    proc = null;
  });
  proc.unref?.();
  const deadline = Date.now() + 5000;
  while (!existsSync(socketOf(num)) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!existsSync(socketOf(num))) {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    proc = null;
    return;
  }
  ourDisplay = num;
  process.env.DISPLAY = `:${num}`;
}

export async function teardown(): Promise<void> {
  if (proc) {
    try {
      proc.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    proc = null;
  }
  // Remove ONLY our own socket (we spawned with -nolock, so there is no lock file of ours).
  if (ourDisplay !== null) {
    try {
      rmSync(socketOf(ourDisplay), { force: true });
    } catch {
      /* best effort — never touch another display's files */
    }
    ourDisplay = null;
  }
}
