// J1 §3 + §5 — the `jira` agent tool and the usage counters behind its limits.
// create/comment go through the powers gate (Quinn's OK) and are restricted to the
// allowlisted projects; every outcome is a `jira` system event the counters read.
import type { Tool, ToolContext, ToolResult } from '../runtime/contract.js';
import type { ModuleDeps } from '../modules.js';
import { gated } from '../powers/gate.js';
import { jiraClient, type JiraClient, type JiraIssue } from './client.js';
import { ISSUE_KEY_RE, JIRA_NOT_CONFIGURED, loadJiraPolicy, type JiraPolicy } from './config.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export interface JiraUsage {
  createsToday: number;
  commentsToday: number;
  searchesHour: number;
}

/** Rolling counts from the `jira` system events (ok:true only). */
export function usage(deps: ModuleDeps, now = Date.now()): JiraUsage {
  let createsToday = 0;
  let commentsToday = 0;
  let searchesHour = 0;
  try {
    for (const e of deps.store.events('')) {
      if (e.kind !== 'jira' || e.data?.ok !== true) continue;
      const age = now - e.ts;
      if (e.data.kind === 'create' && age <= DAY_MS) createsToday++;
      else if (e.data.kind === 'comment' && age <= DAY_MS) commentsToday++;
      else if (e.data.kind === 'search' && age <= HOUR_MS) searchesHour++;
    }
  } catch {
    /* counters fail open-closed: 0 counts, the caps still apply from policy */
  }
  return { createsToday, commentsToday, searchesHour };
}

function log(deps: ModuleDeps, data: { kind: 'create' | 'comment' | 'search'; ok: boolean; key?: string; summary?: string; project?: string }): void {
  try {
    deps.store.appendEvent('', null, 'jira', data);
  } catch {
    /* the event log must never break a tool */
  }
}

/** The client, reading deps.extra.fetch when a test injected one. */
export function clientFor(deps: ModuleDeps): JiraClient | null {
  return jiraClient(deps.env ?? {}, ((deps.extra?.fetch as typeof fetch | undefined) ?? fetch) as typeof fetch);
}

const line = (i: JiraIssue) =>
  `${i.key} [${i.status}] (${i.type}${i.priority ? `, ${i.priority}` : ''}) ${i.summary}${i.due ? ` — due ${i.due}` : ''}`;

export function jiraTool(deps: ModuleDeps): Tool {
  return {
    kind: 'write',
    caps: ['network', 'people'],
    schema: {
      name: 'jira',
      description: "Quinn's work Jira. op: search|get|create|comment. create/comment need Quinn's OK and are limited to allowed projects.",
      parameters: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['search', 'get', 'create', 'comment'] },
          jql: { type: 'string' },
          key: { type: 'string' },
          project: { type: 'string' },
          type: { type: 'string' },
          summary: { type: 'string' },
          description: { type: 'string' },
          text: { type: 'string' },
          max: { type: 'number' },
        },
        required: ['op'],
      },
    },
    async run(args: any, ctx: ToolContext): Promise<ToolResult> {
      try {
        const op = String(args?.op ?? '');
        if (op !== 'search' && op !== 'get' && op !== 'create' && op !== 'comment') {
          return { ok: false, output: 'not allowed: jira supports search, get, create, comment only' };
        }
        const client = clientFor(deps);
        if (!client) return { ok: false, output: JIRA_NOT_CONFIGURED };
        const policy = loadJiraPolicy(deps);
        if (op === 'search') return await doSearch(deps, client, policy, args);
        if (op === 'get') return await doGet(deps, client, args);
        if (op === 'create') return await doCreate(deps, client, policy, args, ctx);
        return await doComment(deps, client, policy, args, ctx);
      } catch (e: any) {
        return { ok: false, output: `error: ${e?.message ?? String(e)}` };
      }
    },
  };
}

async function doSearch(deps: ModuleDeps, client: JiraClient, policy: JiraPolicy, args: any): Promise<ToolResult> {
  const jql = typeof args?.jql === 'string' ? args.jql.trim() : '';
  if (!jql) return { ok: false, output: 'jql is required for search' };
  if (jql.length > 500) return { ok: false, output: 'jql must be ≤ 500 characters' };
  const max = Math.min(Math.max(1, Math.round(Number(args?.max) || 10)), 20);
  const u = usage(deps);
  if (u.searchesHour >= policy.limits.searchesPerHour) {
    log(deps, { kind: 'search', ok: false });
    return { ok: false, output: `hourly limit of ${policy.limits.searchesPerHour} Jira searches reached` };
  }
  try {
    const { issues } = await client.search(jql, max);
    log(deps, { kind: 'search', ok: true });
    return { ok: true, output: `${issues.map(line).join('\n')}${issues.length ? '\n' : ''}${issues.length} issue${issues.length === 1 ? '' : 's'}` };
  } catch (e: any) {
    log(deps, { kind: 'search', ok: false });
    return { ok: false, output: `error: ${e?.message ?? String(e)}` };
  }
}

async function doGet(deps: ModuleDeps, client: JiraClient, args: any): Promise<ToolResult> {
  const key = String(args?.key ?? '').trim().toUpperCase();
  if (!ISSUE_KEY_RE.test(key)) return { ok: false, output: 'key is required (like WORK-123)' };
  const i = await client.get(key);
  return {
    ok: true,
    output: `${i.key} [${i.status}] (${i.type}${i.priority ? `, ${i.priority}` : ''}) ${i.summary}` +
      `${i.due ? `\ndue: ${i.due}` : ''}${i.assignee ? `\nassignee: ${i.assignee}` : ''}\n${i.url}` +
      `${i.description ? `\n\n${i.description}` : ''}`,
  };
}

async function doCreate(deps: ModuleDeps, client: JiraClient, policy: JiraPolicy, args: any, ctx: ToolContext): Promise<ToolResult> {
  const project = String(args?.project ?? '').trim().toUpperCase();
  const type = String(args?.type ?? '').trim();
  const summary = typeof args?.summary === 'string' ? args.summary.trim() : '';
  const description = typeof args?.description === 'string' ? args.description.trim() : '';
  if (!policy.projects.length) return { ok: false, output: 'no Jira projects are allowed for agents (set projects in config/jira.yaml)' };
  if (!policy.projects.includes(project)) {
    return { ok: false, output: `project ${project || '?'} is not allowed. Allowed: ${policy.projects.join(', ')}` };
  }
  if (!policy.issueTypes.includes(type)) {
    return { ok: false, output: `issue type "${type || '?'}" is not allowed. Allowed: ${policy.issueTypes.join(', ')}` };
  }
  if (summary.length < 3 || summary.length > 200 || summary.includes('\n')) {
    return { ok: false, output: 'summary must be a single line of 3..200 characters' };
  }
  if (description.length > 4000) return { ok: false, output: 'description must be ≤ 4000 characters' };
  const u = usage(deps);
  if (u.createsToday >= policy.limits.createsPerDay) {
    log(deps, { kind: 'create', ok: false, project, summary });
    return { ok: false, output: `daily limit of ${policy.limits.createsPerDay} Jira tickets reached` };
  }
  const dup = deps.store
    .events('')
    .some((e) => e.kind === 'jira' && e.data?.kind === 'create' && e.data.ok === true && e.data.summary === summary && Date.now() - e.ts <= 7 * DAY_MS);
  if (dup) return { ok: false, output: `a ticket with that exact summary was already created in the last 7 days — skip it` };

  const fullDesc = `${description ? `${description}\n\n` : ''}— created by alfred (Quinn's assistant)`;
  const detail = `jira create ${project}/${type}: ${summary}`;
  const result = await gated(
    { deps, tool: ctx },
    'jira.create',
    detail,
    async () => {
      try {
        const r = await client.create({ project, type, summary, description: fullDesc, labels: ['alfred'] });
        log(deps, { kind: 'create', ok: true, key: r.key, summary, project });
        return { ok: true, output: `created ${r.key} ${r.url}` };
      } catch (e: any) {
        log(deps, { kind: 'create', ok: false, summary, project });
        return { ok: false, output: `error: ${e?.message ?? String(e)}` };
      }
    },
    { info: JSON.stringify({ project, type, summary, description }) },
  );
  return result;
}

async function doComment(deps: ModuleDeps, client: JiraClient, policy: JiraPolicy, args: any, ctx: ToolContext): Promise<ToolResult> {
  const key = String(args?.key ?? '').trim().toUpperCase();
  const text = typeof args?.text === 'string' ? args.text.trim() : '';
  if (!ISSUE_KEY_RE.test(key)) return { ok: false, output: 'key is required (like WORK-123)' };
  const project = key.slice(0, key.indexOf('-'));
  if (!policy.projects.includes(project)) {
    return { ok: false, output: `project ${project} is not allowed. Allowed: ${policy.projects.join(', ') || 'none (set projects in config/jira.yaml)'}` };
  }
  if (!text || text.length > 2000) return { ok: false, output: 'text must be 1..2000 characters' };
  const u = usage(deps);
  if (u.commentsToday >= policy.limits.commentsPerDay) {
    log(deps, { kind: 'comment', ok: false, key });
    return { ok: false, output: `daily limit of ${policy.limits.commentsPerDay} Jira comments reached` };
  }
  const result = await gated(
    { deps, tool: ctx },
    'jira.comment',
    `jira comment ${key}: ${text.slice(0, 200)}`,
    async () => {
      try {
        const r = await client.comment(key, text);
        log(deps, { kind: 'comment', ok: true, key });
        return { ok: true, output: `commented on ${key}${r.id ? ` (${r.id})` : ''}` };
      } catch (e: any) {
        log(deps, { kind: 'comment', ok: false, key });
        return { ok: false, output: `error: ${e?.message ?? String(e)}` };
      }
    },
    { info: text },
  );
  return result;
}
