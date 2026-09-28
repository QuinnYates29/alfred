// J1 §2 — the Jira Cloud REST client. Credentials come in as `env`, are used only in the
// Basic auth header, and never appear in outputs or thrown messages. Every call has a 20 s
// timeout. Issue keys are validated before any URL is built.
import { jiraCreds, ISSUE_KEY_RE, JIRA_NOT_CONFIGURED, type JiraCreds } from './config.js';
import type { ModuleDeps } from '../modules.js';

const TIMEOUT_MS = 20_000;
const SEARCH_FIELDS = ['summary', 'status', 'priority', 'duedate', 'issuetype', 'project', 'assignee', 'updated', 'labels'];
const STATUS_KEYS = ['new', 'indeterminate', 'done'];

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  statusCategory: 'new' | 'indeterminate' | 'done';
  priority: string | null;
  due: string | null;
  type: string;
  project: string;
  assignee: string | null;
  updated: string;
  url: string;
  description?: string;
}

export interface JiraClient {
  search(jql: string, max: number): Promise<{ issues: JiraIssue[] }>;
  get(key: string): Promise<JiraIssue>;
  create(i: { project: string; type: string; summary: string; description?: string; labels?: string[] }): Promise<{ key: string; url: string }>;
  comment(key: string, text: string): Promise<{ id: string }>;
  myself(): Promise<{ accountId: string; displayName: string }>;
}

export interface JiraEnv {
  JIRA_SITE?: string;
  JIRA_EMAIL?: string;
  JIRA_API_TOKEN?: string;
}

function credsFrom(env: JiraEnv): JiraCreds | null {
  return jiraCreds({ env: env as Record<string, string | undefined>, extra: {} } as unknown as ModuleDeps);
}

/** Error message with any secret scrubbed and the detail cut to 300 chars. */
function fail(status: number | string, detail: string, c: JiraCreds): Error {
  const msg = String(detail || '').slice(0, 300);
  return new Error(`Jira ${status}: ${msg.replaceAll(c.token, '***').replaceAll(c.email, '***')}`);
}

function errDetail(data: any, status: number): string {
  if (Array.isArray(data?.errorMessages) && data.errorMessages.length) return data.errorMessages.join('; ');
  if (data?.message) return String(data.message);
  if (data?.errorMessages) return Object.entries(data.errorMessages).map(([k, v]) => `${k}: ${v}`).join('; ');
  return `HTTP ${status}`;
}

/** Flatten an ADF document to plain text: text nodes in order, newline between paragraphs. */
export function adfToText(node: any, out: string[] = []): string {
  if (!node || typeof node !== 'object') return out.join('');
  if (node.type === 'text' && typeof node.text === 'string') out.push(node.text);
  if (node.type === 'paragraph') out.push('\n');
  const kids = Array.isArray(node.content) ? node.content : [];
  for (const k of kids) adfToText(k, out);
  if (node.type === 'paragraph') out.push('\n');
  return out.join('');
}

export function flattenAdf(doc: any): string {
  return adfToText(doc).replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').trimEnd().slice(0, 4000);
}

/** Plain text → ADF doc: one paragraph per line. */
export function toAdf(text: string): any {
  const lines = String(text ?? '').split(/\r?\n/);
  return {
    type: 'doc',
    version: 1,
    content: lines.map((l) => (l ? { type: 'paragraph', content: [{ type: 'text', text: l }] } : { type: 'paragraph' })),
  };
}

function toIssue(c: JiraCreds, raw: any): JiraIssue {
  const f = raw?.fields ?? {};
  const cat = f.status?.statusCategory?.key;
  return {
    key: String(raw?.key ?? ''),
    summary: typeof f.summary === 'string' ? f.summary : '',
    status: f.status?.name ?? '',
    statusCategory: STATUS_KEYS.includes(cat) ? cat : 'new',
    priority: f.priority?.name ?? null,
    due: f.duedate ?? null,
    type: f.issuetype?.name ?? '',
    project: f.project?.key ?? '',
    assignee: f.assignee?.displayName ?? null,
    updated: f.updated ?? '',
    url: `${c.site}/browse/${String(raw?.key ?? '')}`,
  };
}

export function jiraClient(env: JiraEnv, fetchImpl: typeof fetch = fetch): JiraClient | null {
  const maybe = credsFrom(env);
  if (!maybe) return null;
  const c: JiraCreds = maybe;
  const auth = 'Basic ' + Buffer.from(`${c.email}:${c.token}`).toString('base64');

  async function req(method: string, path: string, body?: any): Promise<any> {
    let res: Response;
    try {
      res = await fetchImpl(`${c.site}${path}`, {
        method,
        headers: { authorization: auth, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e: any) {
      throw new Error(`Jira request failed: ${String(e?.message ?? e).replaceAll(c.token, '***').replaceAll(c.email, '***').slice(0, 200)}`);
    }
    let data: any = null;
    try {
      data = await res.json();
    } catch {
      /* empty or non-JSON body */
    }
    if (!res.ok) throw fail(res.status, errDetail(data, res.status), c);
    return data;
  }

  const needKey = (key: string) => {
    if (!ISSUE_KEY_RE.test(String(key ?? ''))) throw new Error(`invalid Jira issue key: ${String(key ?? '').slice(0, 40)}`);
  };

  return {
    async search(jql, max) {
      const data = await req('POST', '/rest/api/3/search/jql', { jql, maxResults: Math.min(Math.max(1, Math.round(max) || 1), 50), fields: SEARCH_FIELDS });
      const issues = Array.isArray(data?.issues) ? data.issues.map((i: any) => toIssue(c, i)) : [];
      return { issues };
    },
    async get(key) {
      needKey(key);
      const data = await req('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${[...SEARCH_FIELDS, 'description'].join(',')}`);
      const issue = toIssue(c, data);
      issue.description = data?.fields?.description ? flattenAdf(data.fields.description) : '';
      return issue;
    },
    async create(i) {
      const data = await req('POST', '/rest/api/3/issue', {
        fields: {
          project: { key: i.project },
          issuetype: { name: i.type },
          summary: i.summary,
          description: toAdf(i.description ?? ''),
          ...(i.labels?.length ? { labels: i.labels } : {}),
        },
      });
      const key = String(data?.key ?? '');
      if (!ISSUE_KEY_RE.test(key)) throw fail('create', 'no issue key in the response', c);
      return { key, url: `${c.site}/browse/${key}` };
    },
    async comment(key, text) {
      needKey(key);
      const data = await req('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body: toAdf(text) });
      return { id: String(data?.id ?? '') };
    },
    async myself() {
      const data = await req('GET', '/rest/api/3/myself');
      return { accountId: String(data?.accountId ?? ''), displayName: String(data?.displayName ?? '') };
    },
  };
}

export { JIRA_NOT_CONFIGURED };
