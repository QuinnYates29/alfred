// Vitest globalSetup: give Electron-based acceptance tests (p18) an X display when the
// machine has none (headless/sandboxed CI). p18's own doc says "run under xvfb"; this
// makes a plain `vitest run` behave the same. No-op when DISPLAY is already set or no
// Xvfb binary exists — never fails the suite.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default async function setup(): Promise<(() => Promise<void>) | void> {
  if (process.platform !== 'linux' || process.env.DISPLAY) return;
  for (const n of [99, 98, 97]) {
    const sock = `/tmp/.X11-unix/X${n}`;
    try {
      rmSync(sock, { force: true });
      rmSync(`/tmp/.X${n}-lock`, { force: true });
      mkdirSync('/tmp/.X11-unix', { recursive: true });
    } catch {
      continue;
    }
    // -extension GLX: GLX init segfaults in the sandbox; Electron runs with --disable-gpu.
    let p: ReturnType<typeof spawn> | null = null;
    try {
      p = spawn('Xvfb', [`:${n}`, '-screen', '0', '1280x1024x24', '-nolisten', 'tcp', '-extension', 'GLX'], { stdio: 'ignore' });
    } catch {
      continue;
    }
    let up = false;
    for (let i = 0; i < 50; i++) {
      if (existsSync(sock)) { up = true; break; }
      if (p.exitCode !== null || p.signalCode) break;
      await wait(100);
    }
    if (up) {
      process.env.DISPLAY = `:${n}`;
      return async () => {
        try { p?.kill('SIGTERM'); } catch { /* already gone */ }
      };
    }
    p?.kill('SIGKILL');
  }
}
