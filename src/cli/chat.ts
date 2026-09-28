// P19 — chat commands: one-shot `ask` and interactive `chat`.
import { createInterface } from 'node:readline';
import { Api, flag, Parsed } from './util.js';

// POST /chat returns reply as a ChatMessage object ({ role, content, … }); tolerate a plain string too.
const replyText = (out: any): string =>
  typeof out?.reply === 'string' ? out.reply : String(out?.reply?.content ?? '');

export async function cmdAsk(api: Api, p: Parsed): Promise<void> {
  const text = p.rest[0];
  if (!text) throw new Error('usage: alfred ask "<text>" [--thread id] [--private]');
  const body: Record<string, unknown> = { text, source: 'cli' };
  if (flag(p, 'thread')) body.threadId = flag(p, 'thread');
  if (p.bools.has('private')) body.private = true;
  const out = await api.req('POST', '/chat', body);
  if (p.bools.has('json')) return void console.log(JSON.stringify(out, null, 2));
  process.stdout.write(`${replyText(out).trim()}\n`);
  console.error(`(thread ${out.threadId})`);
}

export async function cmdChat(api: Api, p: Parsed): Promise<void> {
  let threadId = flag(p, 'thread');
  const priv = p.bools.has('private');
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'you> ' });
  console.error(
    `alfred chat${threadId ? ` (thread ${threadId})` : ''}${priv ? ' — PRIVATE (local model, no tools, nothing saved)' : ''} — /quit to exit`,
  );
  for (;;) {
    const line = (await new Promise<string>((res) => rl.question('you> ', res))).trim();
    if (!line || line === '/quit' || line === '/exit') break;
    try {
      const body: Record<string, unknown> = { text: line, source: 'cli' };
      if (threadId) body.threadId = threadId;
      else if (priv) body.private = true;
      const out = await api.req('POST', '/chat', body);
      threadId = out.threadId ?? threadId;
      console.log(replyText(out).trim());
    } catch (e: any) {
      console.error(`alfred: ${e?.message ?? e}`);
    }
  }
  rl.close();
}
