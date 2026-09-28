// P19 — chat commands: one-shot `ask` and interactive `chat`.
import { createInterface } from 'node:readline';
import { Api, flag, Parsed } from './util.js';

export async function cmdAsk(api: Api, p: Parsed): Promise<void> {
  const text = p.rest[0];
  if (!text) throw new Error('usage: alfred ask "<text>" [--thread id]');
  const body: Record<string, unknown> = { text };
  if (flag(p, 'thread')) body.threadId = flag(p, 'thread');
  const out = await api.req('POST', '/chat', body);
  if (p.bools.has('json')) return void console.log(JSON.stringify(out, null, 2));
  process.stdout.write(`${String(out.reply ?? '').trim()}\n`);
  console.error(`(thread ${out.threadId})`);
}

export async function cmdChat(api: Api, p: Parsed): Promise<void> {
  let threadId = flag(p, 'thread');
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'you> ' });
  console.error(`alfred chat${threadId ? ` (thread ${threadId})` : ''} — /quit to exit`);
  for (;;) {
    const line = (await rl.question('you> ')).trim();
    if (!line || line === '/quit' || line === '/exit') break;
    try {
      const body: Record<string, unknown> = { text: line };
      if (threadId) body.threadId = threadId;
      const out = await api.req('POST', '/chat', body);
      threadId = out.threadId ?? threadId;
      console.log(String(out.reply ?? '').trim());
    } catch (e: any) {
      console.error(`alfred: ${e?.message ?? e}`);
    }
  }
  rl.close();
}
