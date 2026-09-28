// J1 §1 — Jira config: env credentials (never logged) + config/jira.yaml policy, read fresh,
// fail-closed. Missing/broken policy = the safe defaults below (agents can't create or comment).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ModuleDeps } from '../modules.js';
import { powersRoot } from '../powers/gate.js';

export const JIRA_NOT_CONFIGURED =
  'Jira is not configured (set JIRA_SITE, JIRA_EMAIL, JIRA_API_TOKEN in ~/.config/alfred.env)';

export const PROJECT_RE = /^[A-Z][A-Z0-9_]{1,9}$/;
export const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]{1,9}-\d{1,7}$/;

export interface JiraLimits {
  createsPerDay: number;
  commentsPerDay: number;
  searchesPerHour: number;
}

export interface JiraImportCfg {
  enabled: boolean;
  jql: string;
  board: string;
  everyMinutes: number;
  max: number;
}

export interface JiraPolicy {
  projects: string[];
  issueTypes: string[];
  limits: JiraLimits;
  import: JiraImportCfg;
}

export const DEFAULT_JIRA_POLICY: JiraPolicy = {
  projects: [],
  issueTypes: ['Task', 'Bug'],
  limits: { createsPerDay: 5, commentsPerDay: 20, searchesPerHour: 60 },
  import: {
    enabled: false,
    jql: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
    board: '',
    everyMinutes: 15,
    max: 50,
  },
};

export function jiraPolicyPath(deps: ModuleDeps): string {
  return join(powersRoot(deps), 'config', 'jira.yaml');
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Number-or-default then clamp. Non-finite input falls back to the default. */
function num(v: any, dflt: number, lo: number, hi: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  const base = Number.isFinite(n) ? Math.round(n) : dflt;
  return clamp(base, lo, hi);
}

function validSite(site: string): boolean {
  return (
    site.startsWith('https://') &&
    !site.slice(8).includes('/') &&
    (site.endsWith('.atlassian.net') || site === 'atlassian.net')
  );
}

export interface JiraCreds {
  site: string;
  email: string;
  token: string;
}

/** Credentials from deps.env. Any missing/invalid piece = null (unconfigured). Never logged. */
export function jiraCreds(deps: ModuleDeps): JiraCreds | null {
  const e = deps.env ?? {};
  const site = e.JIRA_SITE?.trim().replace(/\/+$/, '') ?? '';
  const email = e.JIRA_EMAIL?.trim() ?? '';
  const token = e.JIRA_API_TOKEN?.trim() ?? '';
  if (!site || !email || !token || !validSite(site)) return null;
  return { site, email, token };
}

/** config/jira.yaml, read fresh on each use. Missing/broken = safe defaults (fail closed). */
export function loadJiraPolicy(deps: ModuleDeps): JiraPolicy {
  const d = DEFAULT_JIRA_POLICY;
  const path = jiraPolicyPath(deps);
  if (!existsSync(path)) {
    return { ...d, issueTypes: [...d.issueTypes], limits: { ...d.limits }, import: { ...d.import } };
  }
  let raw: any;
  try {
    raw = parseYaml(readFileSync(path, 'utf8'));
  } catch (e: any) {
    console.error(`[jira] ignoring ${path}: ${e?.message ?? e}`);
    raw = null;
  }
  if (!raw || typeof raw !== 'object') raw = {};
  const projects = Array.isArray(raw.projects)
    ? [...new Set(raw.projects.map((p: any) => String(p).trim()).filter((p: string) => PROJECT_RE.test(p)))]
    : [];
  const issueTypes = Array.isArray(raw.issueTypes)
    ? [...new Set(raw.issueTypes.map((t: any) => String(t).trim()).filter((t: string) => t.length >= 1 && t.length <= 60))]
    : [];
  const imp = raw.import && typeof raw.import === 'object' ? raw.import : {};
  const lim = raw.limits && typeof raw.limits === 'object' ? raw.limits : {};
  const defaults = num(lim.createsPerDay, d.limits.createsPerDay, 0, 50);
  return {
    projects,
    issueTypes,
    limits: {
      createsPerDay: defaults,
      commentsPerDay: num(lim.commentsPerDay, d.limits.commentsPerDay, 0, 200),
      searchesPerHour: num(lim.searchesPerHour, d.limits.searchesPerHour, 0, 600),
    },
    import: {
      enabled: imp.enabled === true,
      jql: typeof imp.jql === 'string' && imp.jql.trim() ? String(imp.jql) : d.import.jql,
      board: typeof imp.board === 'string' ? imp.board.trim() : '',
      everyMinutes: num(imp.everyMinutes, d.import.everyMinutes, 5, 1440),
      max: num(imp.max, d.import.max, 1, 100),
    },
  };
}
