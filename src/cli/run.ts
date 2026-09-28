// D1 — `alfred run [persona] "<prompt>"`: start an agent run from one prompt.
import { Api, flag, Parsed } from './util.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const USAGE = 'usage: alfred run [persona] "<prompt>" [--repo P] [--node N] [--wait]';

/** Known persona names (from /dispatch/help); an unreachable list just means "no persona words". */
async function personaNames(api: Api): Promise<string[]> {
  try {
    const help = await api.get('/dispatch/help');
    return (help?.personas ?? []).map((p: any) => String(p.name));
  } catch {
    return [];
  }
}

export async function cmdRun(api: Api, p: Parsed): Promise<void> {
  const joined = p.rest.join(' ').trim();
  if (!joined) throw new Error(USAGE);
  const names = await personaNames(api);
  const canonical = (w: string) => names.find((n) => n.toLowerCase() === w.toLowerCase());

  let body = joined;
  let persona = 'alfred';
  let prompt = '';
  if (/^!(?!!)/.test(body)) {
    // `alfred run "!coder fix it"` — the dispatch syntax itself.
    const rest = body.slice(1).trim();
    const [word, ...more] = rest.split(/\s+/);
    const bare = word.startsWith('@') ? word.slice(1) : word;
    if (more.length && canonical(bare)) {
      persona = canonical(bare) as string;
      prompt = more.join(' ').trim();
    } else {
      prompt = rest;
    }
  } else if (p.rest.length >= 2 && canonical(p.rest[0])) {
    persona = canonical(p.rest[0]) as string;
    prompt = p.rest.slice(1).join(' ').trim();
  } else {
    prompt = joined;
  }
  if (!prompt) throw new Error(USAGE);

  const req: Record<string, unknown> = { prompt, persona, source: 'cli' };
  if (flag(p, 'repo')) req.repo = flag(p, 'repo');
  if (flag(p, 'node')) req.node = flag(p, 'node');
  const out = await api.req('POST', '/dispatch', req);
  const goal = out?.goal ?? {};
  console.log(`started ${out?.persona ?? persona} → ${goal.slug ?? goal.id} (${goal.id})`);
  if (p.bools.has('json') && !p.bools.has('wait')) console.log(JSON.stringify(out, null, 2));
  if (!p.bools.has('wait')) return;

  // Poll every 3 s; print each task status change once; then the root task's result/reason.
  const seen = new Map<string, string>();
  for (;;) {
    const g = await api.get(`/goals/${encodeURIComponent(goal.id)}`);
    for (const t of g?.tasks ?? []) {
      if (seen.get(t.id) !== t.status) {
        seen.set(t.id, t.status);
        console.log(`${t.persona}/${t.title} → ${t.status}`);
      }
    }
    const status = g?.goal?.status;
    if (status === 'done' || status === 'failed') {
      const root = (g?.tasks ?? []).find((t: any) => !t.parentTaskId) ?? (g?.tasks ?? [])[0];
      const text = String(root?.result ?? root?.reason ?? '').trim();
      if (text) console.log(text);
      process.exit(status === 'done' ? 0 : 1);
    }
    await sleep(3000);
  }
}
