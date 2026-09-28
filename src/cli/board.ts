// P19 — board commands: inbox, board, add, item, mv/done, comment, edit, send.
import { Api, flag, flags, Parsed, parseCheck, print } from './util.js';

const enc = encodeURIComponent;

function itemLine(it: any): string {
  const bits = [`  ${it.key}`];
  if (it.priority && it.priority !== 'none') bits.push(`(${it.priority})`);
  bits.push(it.title);
  if (it.assignee) bits.push(`@${it.assignee}`);
  if (it.due) bits.push(`due:${it.due}`);
  return bits.join(' ');
}

export async function cmdBoard(api: Api, p: Parsed): Promise<void> {
  const q = new URLSearchParams();
  if (flag(p, 'board')) q.set('board', flag(p, 'board')!);
  if (flag(p, 'status')) q.set('status', flag(p, 'status')!);
  if (p.bools.has('mine')) q.set('assignee', 'quinn');
  const qs = q.toString();
  const items: any[] = await api.get('/items' + (qs ? `?${qs}` : ''));
  if (p.bools.has('json')) return void console.log(JSON.stringify(items, null, 2));
  const boards: any[] = await api.get('/boards');
  for (const b of boards) {
    const mine = items.filter((it) => it.boardId === b.id);
    if (!mine.length && boards.length > 1) continue;
    if (boards.length > 1) console.log(`-- ${b.key}: ${b.name}`);
    for (const col of b.columns) {
      const list = mine.filter((it) => it.columnId === col.id);
      console.log(`== ${col.name} (${list.length})`);
      for (const it of list) console.log(itemLine(it));
    }
  }
}

export async function cmdAdd(api: Api, p: Parsed): Promise<void> {
  const title = p.rest[0];
  if (!title) throw new Error('usage: alfred add "<title>" [--status s] [--prio p] [--label l]… [--assign a] [--due d] [--desc text] [--board K]');
  const b: Record<string, any> = { title };
  if (flag(p, 'status')) b.status = flag(p, 'status');
  if (flag(p, 'prio')) b.priority = flag(p, 'prio');
  if (flag(p, 'label') || flags(p, 'label').length) b.labels = flags(p, 'label');
  if (flag(p, 'assign')) b.assignee = flag(p, 'assign');
  if (flag(p, 'due')) b.due = flag(p, 'due');
  if (flag(p, 'desc')) b.description = flag(p, 'desc');
  if (flag(p, 'board')) b.board = flag(p, 'board');
  const it = await api.req('POST', '/items', b);
  print(p, it, () => console.log(`created ${it.key}`));
}

export async function cmdItem(api: Api, p: Parsed, key: string): Promise<void> {
  const d = await api.get(`/items/${enc(key)}`);
  print(p, d, () => {
    const it = d.item;
    console.log(`${it.key} [${it.status}] ${it.title}`);
    if (it.priority && it.priority !== 'none') console.log(`  prio      ${it.priority}`);
    if (it.assignee) console.log(`  assignee  ${it.assignee}`);
    if (it.due) console.log(`  due       ${it.due}`);
    if (it.labels?.length) console.log(`  labels    ${it.labels.join(', ')}`);
    if (it.parentId) console.log(`  parent    ${it.parentId}`);
    if (it.description) console.log(`\n${it.description}\n`);
    for (const c of it.checklist ?? []) console.log(`  [${c.done ? 'x' : ' '}] ${c.text}`);
    for (const c of d.comments ?? []) console.log(`  ${c.author}: ${c.body}`);
    for (const g of d.goals ?? []) console.log(`  goal ${g.slug} [${g.status}] ${g.title}`);
  });
}

async function move(api: Api, key: string, status: string): Promise<any> {
  return api.req('POST', `/items/${enc(key)}/move`, { status });
}

export async function cmdMv(api: Api, p: Parsed, key: string, status: string): Promise<void> {
  const it = await move(api, key, status);
  print(p, it, () => console.log(`${it.key} → ${it.status}`));
}

export async function cmdDone(api: Api, p: Parsed, key: string): Promise<void> {
  const it = await move(api, key, 'done');
  print(p, it, () => console.log(`${it.key} → ${it.status}`));
}

export async function cmdComment(api: Api, p: Parsed, key: string, body: string): Promise<void> {
  const c = await api.req('POST', `/items/${enc(key)}/comments`, { body });
  print(p, c, () => console.log(`commented on ${key}`));
}

export async function cmdEdit(api: Api, p: Parsed, key: string): Promise<void> {
  const patch: Record<string, any> = {};
  if (flag(p, 'title')) patch.title = flag(p, 'title');
  if (flag(p, 'prio')) patch.priority = flag(p, 'prio');
  if (flag(p, 'assign')) patch.assignee = flag(p, 'assign');
  if (flag(p, 'due')) patch.due = flag(p, 'due');
  if (flags(p, 'label').length) patch.labels = flags(p, 'label');
  if (flag(p, 'desc')) patch.description = flag(p, 'desc');
  if (!Object.keys(patch).length) throw new Error('nothing to edit (--title/--prio/--assign/--due/--label/--desc)');
  const it = await api.req('PATCH', `/items/${enc(key)}`, patch);
  print(p, it, () => console.log(`updated ${it.key}`));
}

export async function cmdSend(api: Api, p: Parsed, key: string): Promise<void> {
  const b: Record<string, any> = {};
  if (flag(p, 'persona')) b.persona = flag(p, 'persona');
  if (flag(p, 'repo')) b.repo = flag(p, 'repo');
  if (flag(p, 'node')) b.node = flag(p, 'node');
  const checks = flags(p, 'check');
  if (checks.length) b.acceptance = checks.map(parseCheck);
  if (flag(p, 'note')) b.note = flag(p, 'note');
  const out = await api.req('POST', `/items/${enc(key)}/dispatch`, b);
  print(p, out, () => {
    const persona = out.task?.persona ?? b.persona ?? 'alfred';
    console.log(`sent ${key} → goal ${out.goal.slug} (${persona})`);
  });
}

export async function cmdInbox(api: Api, p: Parsed): Promise<void> {
  const approvals: any[] = await api.get('/approvals?status=pending');
  const goals: any[] = await api.get('/goals');
  const parked: { slug: string; id8: string; status: string; title: string }[] = [];
  for (const gs of goals) {
    const c = gs.counts ?? {};
    if ((Number(c.blocked) || 0) + (Number(c.needs_claude) || 0) > 0) {
      const d = await api.get(`/goals/${enc(gs.goal.id)}`);
      for (const t of d.tasks ?? []) {
        if (t.status === 'blocked' || t.status === 'needs_claude') {
          parked.push({ slug: gs.goal.slug, id8: t.id.slice(0, 8), status: t.status, title: t.title });
        }
      }
    }
  }
  const failed = goals.filter((gs) => gs.goal.status === 'failed');
  const boardItems: any[] = await api.get('/items?label=needs-attention');

  if (!approvals.length && !parked.length && !failed.length && !boardItems.length) {
    return void print(p, { approvals, parked, failed, boardItems }, () => console.log('Inbox zero.'));
  }
  print(p, { approvals, parked, failed, boardItems }, () => {
    console.log('Approvals');
    if (!approvals.length) console.log('  none');
    for (const a of approvals) {
      console.log(`  ${a.id.slice(0, 8)}  ${a.action}${a.goalId ? ` goal ${a.goalId.slice(0, 8)}` : ''}  ${a.detail ? `— ${a.detail.split('\n')[0]}` : ''}`);
    }
    console.log('Parked');
    if (!parked.length) console.log('  none');
    for (const t of parked) console.log(`  ${t.id8}  ${t.slug}  [${t.status}] ${t.title}`);
    console.log('Failed goals');
    if (!failed.length) console.log('  none');
    for (const gs of failed) console.log(`  ${gs.goal.id.slice(0, 8)}  ${gs.goal.slug}  ${gs.goal.title}`);
    console.log('Board');
    if (!boardItems.length) console.log('  none');
    for (const it of boardItems) console.log(itemLine(it));
  });
}
