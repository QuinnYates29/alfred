// P2 acceptance — written by the orchestrator. Do not edit to make it pass.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { openStore } from '../../../src/store.js';
import { workspaceFor } from '../../../src/workspace.js';

describe('goal meta and workspaces', () => {
  it('plain goals get a directory; children share the root workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'alfred-work-'));
    const s = openStore(':memory:');
    const g = s.createGoal({ title: 'Plain Goal' });
    expect(g.meta).toEqual({});
    const t = s.createTask({ goalId: g.id, persona: 'alfred', title: 'root' });
    const c = s.createTask({ goalId: g.id, parentTaskId: t.id, persona: 'coder', title: 'kid' });
    const w1 = workspaceFor(s, t, { root });
    expect(w1).toBe(join(root, 'plain-goal'));
    expect(existsSync(w1)).toBe(true);
    expect(workspaceFor(s, c, { root })).toBe(w1);
  });

  it('repo goals get an isolated worktree branch, idempotently, without touching the repo', () => {
    const root = mkdtempSync(join(tmpdir(), 'alfred-work-'));
    const repo = mkdtempSync(join(tmpdir(), 'alfred-repo-'));
    execSync('git init -q -b main && echo a > a.txt && git add . && git -c user.email=a@b -c user.name=t commit -q -m init', { cwd: repo });
    const s = openStore(':memory:');
    const g = s.createGoal({ title: 'Repo Goal', meta: { repo } });
    s.setGoalMeta(g.id, { note: 'x' });
    expect(s.getGoal(g.id)!.meta).toEqual({ repo, note: 'x' });
    const t = s.createTask({ goalId: g.id, persona: 'coder', title: 'root' });
    const w = workspaceFor(s, t, { root });
    expect(w).toBe(join(root, 'repo-goal', t.id.slice(0, 8)));
    expect(readFileSync(join(w, 'a.txt'), 'utf8').trim()).toBe('a');
    expect(execSync('git branch --show-current', { cwd: w }).toString().trim()).toBe(`alfred/repo-goal/${t.id.slice(0, 8)}`);
    expect(execSync('git branch --show-current', { cwd: repo }).toString().trim()).toBe('main');
    expect(workspaceFor(s, t, { root })).toBe(w);
  });
});

