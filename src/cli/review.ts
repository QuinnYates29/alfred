// P19 — review commands: diff, merge, discard, transcript, files, cat.
import { Api, confirm, enc, flag, Parsed, print } from './util.js';

export async function cmdDiff(api: Api, p: Parsed, goalRef: string): Promise<void> {
  const file = flag(p, 'file');
  const branch = flag(p, 'branch');
  const q = new URLSearchParams();
  if (file) q.set('file', file);
  if (branch) q.set('branch', branch);
  const qs = q.toString();
  const d = await api.get(`/goals/${enc(goalRef)}/changes${qs ? `?${qs}` : ''}`);
  print(p, d, () => {
    if (file) {
      console.log(d.diff ?? '');
      return;
    }
    for (const b of d.branches ?? []) console.log(`branch ${b.branch} (base ${d.base ?? '?'})${b.sha ? ` @ ${b.sha.slice(0, 7)}` : ''}`);
    if (!(d.branches ?? []).length) console.log(`no pushed branches for ${goalRef}`);
    for (const c of d.commits ?? []) console.log(`  ${c.sha.slice(0, 7)} ${c.subject} (${c.author})`);
    for (const f of d.files ?? []) console.log(`${f.status} ${f.path} +${f.additions} -${f.deletions}`);
    if (d.diff) process.stdout.write(`${d.diff.endsWith('\n') ? d.diff : `${d.diff}\n`}`);
    if (d.truncated) console.log('(diff truncated)');
  });
}

export async function cmdMerge(api: Api, p: Parsed, goalRef: string): Promise<void> {
  if (!(await confirm(`merge ${goalRef}`, p))) return;
  const body: Record<string, unknown> = { confirm: true, by: 'cli' };
  if (p.bools.has('squash')) body.strategy = 'squash';
  if (flag(p, 'into')) body.into = flag(p, 'into');
  if (p.bools.has('keep-branch')) body.deleteBranch = false;
  const out = await api.req('POST', `/goals/${enc(goalRef)}/merge`, body);
  print(p, out, () => console.log(`merged into ${out.into} @ ${String(out.sha).slice(0, 7)}`));
}

export async function cmdDiscard(api: Api, p: Parsed, goalRef: string): Promise<void> {
  if (!(await confirm(`discard ${goalRef}`, p))) return;
  const body: Record<string, unknown> = { confirm: true, by: 'cli' };
  if (flag(p, 'branch')) body.branch = flag(p, 'branch');
  const out = await api.req('POST', `/goals/${enc(goalRef)}/discard`, body);
  print(p, out, () => console.log(`discarded ${(out.branches ?? []).join(', ') || 'nothing'}`));
}

export async function cmdTranscript(api: Api, p: Parsed, taskId: string): Promise<void> {
  const rows = await api.get(`/tasks/${enc(taskId)}/transcript`);
  print(p, rows, () => {
    for (const e of rows) {
      if (e.kind === 'turn') {
        console.log(`turn ${e.turn}: ${e.text ?? ''}`);
        for (const c of e.calls ?? []) console.log(`  → ${c.name} ${c.args ?? ''}`);
      } else if (e.kind === 'tool') {
        const ok = e.ok === false ? 'err' : 'ok';
        console.log(`  ← ${ok} ${e.name ?? ''} ${String(e.output ?? '').split('\n')[0] ?? ''}`.trimEnd());
      } else if (e.kind === 'transition') {
        console.log(`[${e.from}→${e.to}] ${e.reason ?? ''}`.trimEnd());
      } else {
        const text = e.text ?? e.summary ?? e.reason ?? '';
        console.log(`[${e.kind}] ${String(text).split('\n')[0] ?? ''}`.trimEnd());
      }
    }
  });
}

export async function cmdFiles(api: Api, p: Parsed, goalRef: string): Promise<void> {
  const path = p.rest[1];
  const qs = path ? `?path=${enc(path)}` : '';
  const d = await api.get(`/goals/${enc(goalRef)}/files${qs}`);
  print(p, d, () => {
    for (const en of d.entries ?? []) console.log(en.dir ? `${en.name}/` : en.name);
  });
}

export async function cmdCat(api: Api, p: Parsed, goalRef: string, path: string): Promise<void> {
  const d = await api.get(`/goals/${enc(goalRef)}/file?path=${enc(path)}`);
  print(p, d, () => process.stdout.write(d.content ?? ''));
}
