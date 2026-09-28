// P19 — login + the P4 commands (goal / status / show / tail). P4 output unchanged.
import { readFileSync } from 'node:fs';
import { Api, flag, Parsed, parseCheck, print, splitFrontmatter, writeConfig } from './util.js';

export async function cmdLogin(api: Api, p: Parsed): Promise<void> {
  const url = flag(p, 'url');
  if (!url) throw new Error('usage: alfred login --url <url> --token <token>');
  const token = flag(p, 'token') ?? '';
  writeConfig(url.replace(/\/+$/, ''), token);
  const probe = new Api(url.replace(/\/+$/, ''), token);
  await probe.req('GET', '/health'); // throws a one-liner if unreachable / unauthorized
  console.log(`ok: ${url.replace(/\/+$/, '')}`);
}

export async function cmdGoal(api: Api, p: Parsed): Promise<void> {
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
    console.error('usage: alfred goal "<title>" [--spec S] [--check "n=cmd"] [--repo P] [--persona P] [--file GOAL.md]');
    process.exit(1);
  }
  b.title = title;
  if (flag(p, 'persona')) b.persona = flag(p, 'persona');
  if (flag(p, 'repo')) b.repo = flag(p, 'repo');
  if (flag(p, 'spec')) b.spec = flag(p, 'spec');
  if (b.spec === undefined) b.spec = title;
  const checks = p.flags.get('check') ?? [];
  if (checks.length) b.acceptance = checks.map(parseCheck);
  const out = await api.req('POST', '/goals', b);
  print(p, out, () => {
    console.log(`created goal ${out.goal.slug}`);
    console.log(`id     ${out.goal.id}`);
    console.log(`task   ${out.task.id}`);
  });
}

export async function cmdStatus(api: Api, p: Parsed): Promise<void> {
  const goals = await api.get('/goals');
  print(p, goals, () => {
    if (!goals.length) return void console.log('no goals — `alfred goal "<title>"` to make one');
    for (const g of goals) {
      const c = g.counts ?? {};
      const counts = Object.entries(c)
        .filter(([, n]) => Number(n) > 0)
        .map(([k, n]) => `${k}=${n}`)
        .join(' ');
      console.log(`${g.id.slice(0, 8)}  ${g.status.padEnd(9)} ${g.title}${counts ? `  [${counts}]` : ''}`);
    }
  });
}

export async function cmdShow(api: Api, p: Parsed, ref: string): Promise<void> {
  const d = await api.get(`/goals/${encodeURIComponent(ref)}`);
  print(p, d, () => {
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
  });
}

export async function cmdTail(api: Api): Promise<void> {
  const url = api.token
    ? `${api.url}/api/v1/events?token=${encodeURIComponent(api.token)}`
    : `${api.url}/api/v1/events`;
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
