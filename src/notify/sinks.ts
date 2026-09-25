// P3 §2 — notification sinks: desktop (notify-send), Slack (webhook or bot), markdown mirror.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Notice, Sink } from '../types.js';
import type { Store } from '../store.js';
import { writeMirror } from '../mirror.js';

const execFileAsync = promisify(execFile);

const EMOJI: Record<Notice['level'], string> = {
  failure: ':rotating_light:',
  warn: ':warning:',
  info: ':information_source:',
};

const URGENCY: Record<Notice['level'], string> = {
  failure: 'critical',
  warn: 'normal',
  info: 'low',
};

export function desktopSink(o?: { exec?: (cmd: string, args: string[]) => Promise<void> }): Sink {
  const exec =
    o?.exec ??
    ((cmd: string, args: string[]) => execFileAsync(cmd, args).then(() => undefined));
  return {
    name: 'desktop',
    async send(n: Notice): Promise<void> {
      await exec('notify-send', ['-a', 'Alfred', '-u', URGENCY[n.level], n.title, n.body]);
    },
  };
}

function slackText(n: Notice, dashboardUrl?: string): string {
  const parts = [`${EMOJI[n.level]} ${n.title}`, n.body];
  if (dashboardUrl && n.goalId) parts.push(`${dashboardUrl}/#/goal/${n.goalId}`);
  return parts.join('\n');
}

export function slackSink(o: {
  webhookUrl?: string;
  botToken?: string;
  channel?: string;
  dashboardUrl?: string;
  fetch?: typeof fetch;
}): Sink {
  const doFetch: typeof fetch = o.fetch ?? ((...a) => fetch(...a));
  return {
    name: 'slack',
    async send(n: Notice): Promise<void> {
      const text = slackText(n, o.dashboardUrl);
      if (o.webhookUrl) {
        const res = await doFetch(o.webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        if (!res.ok) throw new Error(`slack webhook failed: HTTP ${res.status}`);
        return;
      }
      if (o.botToken && o.channel) {
        const res = await doFetch('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${o.botToken}`,
          },
          body: JSON.stringify({ channel: o.channel, text }),
        });
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (!res.ok) throw new Error(`slack api failed: HTTP ${res.status}`);
        if (!data.ok) throw new Error(`slack api failed: ${data.error ?? 'unknown error'}`);
        return;
      }
      throw new Error('slack sink not configured (need webhookUrl or botToken + channel)');
    },
  };
}

export function markdownSink(store: Store, dir: string): Sink {
  return {
    name: 'markdown',
    async send(n: Notice): Promise<void> {
      writeMirror(store, n.goalId, dir);
    },
  };
}

export function sinksFromEnv(
  env: Record<string, string | undefined>,
  store: Store,
  mirrorDir: string,
): { sinks: Sink[]; warnings: string[] } {
  const warnings: string[] = [];
  const dashboardUrl = env.ALFRED_DASHBOARD_URL;
  const sinks: Sink[] = [
    desktopSink(),
    markdownSink(store, mirrorDir),
  ];
  const webhookUrl = env.SLACK_WEBHOOK_URL;
  const botToken = env.SLACK_BOT_TOKEN;
  const channel = env.SLACK_CHANNEL;
  if (webhookUrl || (botToken && channel)) {
    sinks.push(slackSink({ webhookUrl, botToken, channel, dashboardUrl }));
  } else {
    warnings.push('slack not configured');
  }
  return { sinks, warnings };
}
