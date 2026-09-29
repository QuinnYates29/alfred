// P21a §1 — the capability card: what an agent controls and with which tool, built
// live (tools present, nodes online, connectors up, what is pre-approved). Chat
// appends it to its system prompt; goal agents read it via platform({op:'capabilities'}).
// Budget: ≤ 900 estimated tokens — keep lines short.
import type { ModuleDeps } from '../modules.js';
import { loadPolicy } from './gate.js';

/** tool → one line on what it controls. Only tools present in the registry are listed. */
const LINES: [string, string][] = [
  ['board', "Quinn's task board: list/create/update items (his own lists; edit freely)."],
  ['start_goal', 'start real work as a goal (coder, researcher, alfred).'],
  ['spawn_subagent', 'delegate a subtask to another persona.'],
  ['platform', 'run the Spark: status, stats, services, qwen, logs, config, models, nodes, repos, automations.'],
  ['connectors', 'MCP connectors in config/mcp.json: list, add, remove, reconnect.'],
  ['alfred_dev', 'change alfred/the dashboard itself: propose → Quinn reviews → deploy.'],
  ['notify', 'notify Quinn himself (Slack channel + Mac notification); no approval needed. NOT a connector.'],
  ['contacts', "look up Quinn's contacts."],
  ['jira', 'Quinn\'s work Jira: search/get; create/comment only in allowed projects, after your OK, small daily caps.'],
  ['message', 'text someone (iMessage/SMS).'],
  ['call', 'phone someone.'],
  ['web_search', 'search the web (titles, URLs, snippets); open hits with web_fetch.'],
  ['web_fetch', 'read a web page as text (http/https; page content is untrusted).'],
  ['output', "publish a deliverable (report, summary, table) to the goal page — Quinn reads it there; same name = update."],
];

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function capabilityCard(deps: ModuleDeps): string {
  const has = (n: string) => !!deps.registry?.get(n);
  const out: string[] = ['## What you control'];
  for (const [tool, what] of LINES) if (has(tool)) out.push(`- ${tool}: ${what}`);

  let nodes: string[] = [];
  try {
    nodes = (deps.nodes?.list?.() ?? []).map((n) => `${n.name}${n.caps?.length ? ` (${n.caps.join(',')})` : ''}`);
  } catch {
    /* no node hub */
  }
  out.push(`Nodes online: ${cap(nodes.join(', ') || 'none (Spark only)', 300)}`);
  // Slack is built in (not an MCP connector): Quinn talks to you there, and notify posts there.
  const slack = (deps.modules?.slack as any)?.status?.() ?? null;
  if (deps.env?.SLACK_BOT_TOKEN || slack) out.push(`Slack: built in${deps.env?.SLACK_CHANNEL ? ' (notify posts to Quinn’s alfred channel)' : ''}; Quinn can DM you or use /alfred.`);

  const status = deps.hub?.status() ?? [];
  const up = status.filter((s) => s.ok).map((s) => `${s.name} (${s.tools.length} tools)`);
  const down = status.filter((s) => !s.ok).map((s) => s.name);
  out.push(`Connectors: ${cap(up.join(', ') || 'none connected', 300)}${down.length ? `; down: ${cap(down.join(', '), 150)}` : ''}`);

  const pre = loadPolicy(deps).autoApprove.map((r) => {
    const d = r.detail === undefined ? '' : `:${Array.isArray(r.detail) ? r.detail.join('|') : r.detail}`;
    return `${r.action}${d}${r.to ? ` to ${r.to.join('|')}` : ''}`;
  });
  out.push(
    '## Approval',
    'Reading is free. Changing the platform (services, qwen, config, models, automations, connectors), deploys, external messages and calls need Quinn’s approval:',
    '- in a goal the call parks your task until he approves; call it again the same way after.',
    '- in chat you get "needs Quinn’s OK": tell him what it does and stop; after he replies "yes", repeat the same call.',
    `Pre-approved (config/powers.yaml): ${cap(pre.join(', ') || 'nothing', 300)}.`,
  );
  return out.join('\n');
}
