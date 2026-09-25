// P3 acceptance — written by the orchestrator. Do not edit to make it pass.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { desktopSink, slackSink, markdownSink, sinksFromEnv } from '../../../src/notify/sinks.js';
import { openStore } from '../../../src/store.js';

describe('notification sinks', () => {
  const notice = { level: 'failure' as const, goalId: 'g1', taskId: 't1', title: 'Build parser failed', body: 'tests red 3x' };

  it('desktop uses notify-send with critical urgency for failures', async () => {
    const calls: any[] = [];
    await desktopSink({ exec: async (cmd, args) => { calls.push([cmd, args]); } }).send(notice);
    expect(calls[0][0]).toBe('notify-send');
    expect(calls[0][1]).toEqual(expect.arrayContaining(['-u', 'critical', 'Build parser failed', 'tests red 3x']));
  });

  it('slack webhook posts the message with a dashboard link, and throws on HTTP errors', async () => {
    const posts: any[] = [];
    const okFetch: any = async (url: string, init: any) => { posts.push([url, JSON.parse(init.body)]); return new Response('ok', { status: 200 }); };
    await slackSink({ webhookUrl: 'https://hooks.slack.test/x', dashboardUrl: 'http://gx10:8790', fetch: okFetch }).send(notice);
    expect(posts[0][0]).toBe('https://hooks.slack.test/x');
    expect(posts[0][1].text).toMatch(/^:rotating_light:/);
    expect(posts[0][1].text).toContain('Build parser failed');
    expect(posts[0][1].text).toContain('http://gx10:8790/#/goal/g1');
    const badFetch: any = async () => new Response('no', { status: 500 });
    await expect(slackSink({ webhookUrl: 'https://x', fetch: badFetch }).send(notice)).rejects.toThrow();
    const botFail: any = async () => new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }), { status: 200 });
    await expect(slackSink({ botToken: 'xoxb', channel: '#alfred', fetch: botFail }).send(notice)).rejects.toThrow(/channel_not_found/);
  });

  it('sinksFromEnv works with Slack unconfigured and warns', () => {
    const store = openStore(':memory:');
    const a = sinksFromEnv({}, store, tmpdir());
    expect(a.sinks.map(s => s.name).sort()).toEqual(['desktop', 'markdown']);
    expect(a.warnings.join(' ')).toMatch(/slack not configured/);
    const b = sinksFromEnv({ SLACK_WEBHOOK_URL: 'https://x' }, store, tmpdir());
    expect(b.sinks.map(s => s.name)).toContain('slack');
  });

  it('markdown sink writes the goal mirror', async () => {
    const store = openStore(':memory:');
    const g = store.createGoal({ title: 'Sink Goal' });
    const dir = mkdtempSync(join(tmpdir(), 'alfred-md-'));
    await markdownSink(store, dir).send({ ...notice, goalId: g.id });
    expect(existsSync(join(dir, 'sink-goal', 'GOAL.md'))).toBe(true);
  });
});

