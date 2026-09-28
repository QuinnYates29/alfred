// Chat dataset commands: `alfred data stats` and `alfred data export [kind] [--since D]`.
import { Api, flag, Parsed } from './util.js';

const KINDS = ['chat', 'feedback', 'goals'];

const sinceMs = (p: Parsed): number | undefined => {
  const s = flag(p, 'since');
  if (!s) return undefined;
  const n = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
  if (!Number.isFinite(n)) throw new Error(`bad --since "${s}" (use a date like 2026-09-01 or epoch ms)`);
  return n;
};

export async function cmdData(api: Api, p: Parsed): Promise<void> {
  const sub = p.rest[0];
  if (sub === 'stats') {
    const out = await api.req('GET', '/chat/dataset/stats');
    if (p.bools.has('json')) return void console.log(JSON.stringify(out, null, 2));
    const fb = out.feedback ?? {};
    console.log(`turns: ${out.turns}  👍 ${fb.up ?? 0}  👎 ${fb.down ?? 0}  ${out.bytes} bytes`);
    console.log(`dir: ${out.dir}`);
    for (const [name, m] of Object.entries((out.byModel ?? {}) as Record<string, any>)) {
      console.log(`  ${name}: ${m.turns} turns, 👍 ${m.up}, 👎 ${m.down}, avg ${m.avgLatencyMs} ms`);
    }
    return;
  }
  if (sub === 'export') {
    const kind = p.rest[1] ?? 'chat';
    if (!KINDS.includes(kind)) throw new Error(`usage: alfred data export [${KINDS.join('|')}] [--since 2026-09-01]`);
    const since = sinceMs(p);
    const q = since ? `&since=${since}` : '';
    process.stdout.write(await api.req('GET', `/chat/dataset/export?kind=${kind}${q}`, undefined, true));
    return;
  }
  throw new Error('usage: alfred data [stats|export [chat|feedback|goals] [--since 2026-09-01]]');
}
