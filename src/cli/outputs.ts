// O1 — goal output commands: `alfred outputs <goal>` (list) and
// `alfred output <goal> <name|id>` (print the content).
import { Api, enc, Parsed, print } from './util.js';

export async function cmdOutputs(api: Api, p: Parsed, goalRef: string): Promise<void> {
  const list = await api.get(`/goals/${enc(goalRef)}/outputs`);
  print(p, list, () => {
    if (!Array.isArray(list) || !list.length) {
      console.log(`no outputs on ${goalRef} yet`);
      return;
    }
    for (const o of list) {
      console.log(`${o.name}  [${o.kind}]  ${o.bytes} bytes  updated ${new Date(o.updatedAt).toISOString()}  (${o.id})`);
    }
  });
}

export async function cmdOutput(api: Api, p: Parsed, goalRef: string, nameOrId: string): Promise<void> {
  const list = await api.get(`/goals/${enc(goalRef)}/outputs`);
  const row = Array.isArray(list)
    ? list.find((o: any) => o.id === nameOrId || o.name === nameOrId)
    : undefined;
  if (!row) throw new Error(`no output "${nameOrId}" on ${goalRef} — try: alfred outputs ${goalRef}`);
  const content: string = await api.req('GET', `/goals/${enc(goalRef)}/outputs/${enc(row.id)}/raw`, undefined, true);
  print(p, { ...row, content }, () => process.stdout.write(content.endsWith('\n') ? content : `${content}\n`));
}
