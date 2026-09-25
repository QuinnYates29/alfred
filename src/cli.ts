#!/usr/bin/env npx tsx
// P4 §5 — the alfred CLI. Talks to the HTTP API (ALFRED_URL, ALFRED_TOKEN).
// `serve` is the only command that does not need a running server.
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

const BASE = (process.env.ALFRED_URL ?? 'http://127.0.0.1:8790').replace(/\/+$/, '');
const TOKEN = process.env.ALFRED_TOKEN ?? '';

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const headers: Record<string, string> = {};
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(BASE + '/api/v1' + path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new Error(`cannot reach alfred at ${BASE} (is \`alfred serve\` running?)`);
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(typeof data?.error === 'string' ? data.error : `${res.status} ${text}`);
  return data;
}

interface Parsed {
  rest: string[];
  flags: Map<string, string[]>; // repeatable (--check)
  bools: Set<string>;
}

function parseArgs(argv: string[]): Parsed {
  const rest: string[] = [];
  const flags = new Map<string, string[]>();
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      bools.add('help');
    } else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        push(flags, a.slice(2, eq), a.slice(eq + 1));
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        push(flags, a.slice(2), argv[++i]);
      } else {
        bools.add(a.slice(2));
      }
    } else {
      rest.push(a);
    }
  }
  return { rest, flags, bools };
}

function push(m: Map<string, string[]>, k: string, v: string) {
  const arr = m.get(k) ?? [];
  arr.push(v);
  m.set(k, arr);
}

const flag = (p: Parsed, k: string) => p.flags.get(k)?.[0];

function parseCheck(s: string): { name: string; cmd: string } {
  const eq = s.indexOf('=');
  if (eq <= 0) throw new Error(`--check wants "name=cmd", got "${s}"`);
  return { name: s.slice(0, eq).trim(), cmd: s.slice(eq + 1).trim() };
}

/** Same `---`-fenced frontmatter shape the markdown automations use. */
function splitFrontmatter(text: string): { fm: Record<string, any>; body: string } {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        const fm = parseYaml(lines.slice(1, i).join('\n')) as Record<string, any>;
        return { fm: fm ?? {}, body: lines.slice(i + 1).join('\n') };
      }
    }
  }
  return { fm: {}, body: text };
}

const USAGE = `alfred — the agent platform

  alfred serve                                   run the server (env: ALFRED_DB, ALFRED_MIRROR_DIR,
                                                 ALFRED_WORK_ROOT, ALFRED_PORT, ALFRED_HOST,
                                                 ALFRED_DECK_DIR, ALFRED_DECK_PORT)
  alfred goal "<title>" [options]                create a goal (with a root task)
      --spec S            spec for the root task (default: --file body, else title)
      --check "n=cmd"     acceptance check (repeatable)
      --repo PATH         repo to work in
      --persona P         persona (default: alfred)
      --file GOAL.md      title/persona/repo/acceptance from frontmatter, body = spec
  alfred status                                list goals, newest first
  alfred show <goal>                           goal detail: tasks, usage, last events
  alfred stop <taskId> [reason]                stop a task
  alfred retry <taskId> [note]                 retry a failed/stopped task (prints new id)
  alfred approve <id> [--deny]                 decide an approval
  alfred tail                                  live event stream (one line per event)

Server: ALFRED_URL (default http://127.0.0.1:8790), ALFRED_TOKEN (Bearer).`;

async function cmdGoal(p: Parsed): Promise<void> {
  let title = p.rest[0] ?? '';
  const b: Record<string, any> = {};
  const file = flag(p, 'file');
  if (file) {
    const { fm, body } = splitFrontmatter(readFileSync(file, 'utf8'));
    if (!title && fm.title) title = String(fm.title);
    if (fm.persona) b.persona = String(fm.persona);
    if (fm.repo) b.repo = String(fm.repo);
    if (Array.isArray(fm.acceptance)) b.acceptance = fm.acceptance;
    if (body.trim()) b.spec = body.trim();
  }
  if (!title) {
    console.error(USAGE);
    process.exit(1);
  }
  b.title = title;
  if (flag(p, 'persona')) b.persona = flag(p, 'persona');
  if (flag(p, 'repo')) b.repo = flag(p, 'repo');
  if (flag(p, 'spec')) b.spec = flag(p, 'spec');
  if (b.spec === undefined) b.spec = title;
  const checks = p.flags.get('check') ?? [];
  if (checks.length) b.acceptance = checks.map(parseCheck);
  const out = await api('POST', '/goals', b);
  console.log(`created goal ${out.goal.slug}`);
  console.log(`id     ${out.goal.id}`);
  console.log(`task   ${out.task.id}`);
}

async function cmdStatus(): Promise<void> {
  const goals = await api('GET', '/goals');
  if (!goals.length) return void console.log('no goals — `alfred goal "<title>"` to make one');
  for (const g of goals) {
    const c = g.counts ?? {};
    const counts = Object.entries(c)
      .filter(([, n]) => Number(n) > 0)
      .map(([k, n]) => `${k}=${n}`)
      .join(' ');
    console.log(`${g.id.slice(0, 8)}  ${g.status.padEnd(9)} ${g.title}${counts ? `  [${counts}]` : ''}`);
  }
}

async function cmdShow(ref: string): Promise<void> {
  const d = await api('GET', `/goals/${encodeURIComponent(ref)}`);
  const g = d.goal;
  console.log(`${g.title}`);
  console.log(`  slug    ${g.slug}`);
  console.log(`  id      ${g.id}`);
  console.log(`  status  ${g.status}${g.repo ? `  repo ${g.repo}` : ''}`);
  if (g.spec) console.log(`  spec    ${String(g.spec).split('\n')[0]}`);
  const u = d.usage;
  if (u) {
    console.log(`  usage   ${u.promptTokens ?? 0} prompt / ${u.completionTokens ?? 0} completion tokens`);
    for (const [persona, per] of Object.entries((u.byPersona ?? {}) as Record<string, any>)) {
      console.log(`          ${persona}: ${per.promptTokens ?? 0} / ${per.completionTokens ?? 0}`);
    }
  }
  console.log(`  tasks`);
  for (const t of d.tasks) {
    console.log(`    ${t.id.slice(0, 8)}  ${t.status.padEnd(9)} [${t.persona}] ${t.title}${t.reason ? ` — ${t.reason}` : ''}`);
  }
  const evs = (d.events ?? []).slice(-8);
  if (evs.length) {
    console.log(`  last events`);
    for (const e of evs) console.log(`    ${new Date(e.ts).toISOString()}  ${e.kind}`);
  }
}

async function cmdTail(): Promise<void> {
  const url = TOKEN
    ? `${BASE}/api/v1/events?token=${encodeURIComponent(TOKEN)}`
    : `${BASE}/api/v1/events`;
  const res = await fetch(url, { headers: { accept: 'text/event-stream' } });
  if (!res.ok || !res.body) throw new Error(`event stream failed: ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = chunk
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .join('\n');
      if (!data) continue; // heartbeat / replay-id chunks
      try {
        const e = JSON.parse(data);
        const t = e.taskId ? ` task=${String(e.taskId).slice(0, 8)}` : '';
        const msg = typeof e.data?.text === 'string' ? ` ${String(e.data.text).slice(0, 120)}` : '';
        console.log(`#${e.id} ${new Date(e.ts).toISOString()} goal=${String(e.goalId).slice(0, 8)}${t} ${e.kind}${msg}`);
      } catch {
        console.log(data);
      }
    }
  }
}

async function main(): Promise<void> {
  const [cmd, ...argv] = process.argv.slice(2);
  const p = parseArgs(argv);
  if (!cmd || p.bools.has('help')) {
    console.log(USAGE);
    return;
  }
  switch (cmd) {
    case 'serve': {
      const { startAlfred, serveConfig } = await import('./main.js');
      const a = await startAlfred(serveConfig());
      console.log(`alfred listening on ${a.url}`);
      const bye = () => {
        void a.stop().then(() => process.exit(0));
      };
      process.on('SIGINT', bye);
      process.on('SIGTERM', bye);
      break;
    }
    case 'goal':
      await cmdGoal(p);
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'show': {
      if (!p.rest[0]) throw new Error('usage: alfred show <goal id or slug>');
      await cmdShow(p.rest[0]);
      break;
    }
    case 'stop': {
      if (!p.rest[0]) throw new Error('usage: alfred stop <taskId> [reason]');
      const out = await api('POST', `/tasks/${encodeURIComponent(p.rest[0])}/stop`, {
        reason: p.rest.slice(1).join(' ') || undefined,
      });
      console.log(`stopped ${p.rest[0]}${out?.via === 'scheduler' ? ' (was running)' : ''}`);
      break;
    }
    case 'retry': {
      if (!p.rest[0]) throw new Error('usage: alfred retry <taskId> [note]');
      const t = await api('POST', `/tasks/${encodeURIComponent(p.rest[0])}/retry`, {
        note: p.rest.slice(1).join(' ') || undefined,
      });
      console.log(`retried as task ${t.id}`);
      break;
    }
    case 'approve': {
      if (!p.rest[0]) throw new Error('usage: alfred approve <id> [--deny]');
      const out = await api('POST', `/approvals/${encodeURIComponent(p.rest[0])}`, {
        decision: p.bools.has('deny') ? 'denied' : 'approved',
      });
      console.log(`approval ${p.rest[0]}: ${p.bools.has('deny') ? 'denied' : 'approved'}`, out ?? '');
      break;
    }
    case 'tail':
      await cmdTail();
      break;
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.error(USAGE);
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(`alfred: ${e?.message ?? e}`);
  process.exit(1);
});
