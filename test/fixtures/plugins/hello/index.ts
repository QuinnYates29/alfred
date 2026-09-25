// Fixture plugin used by the P11 acceptance test and docs/EXTENDING.md.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const sent: any[] = [];

export default {
  name: 'hello',
  version: '1.0.0',
  setup(ctx: any) {
    ctx.registerTool({
      kind: 'read',
      schema: { name: 'hello_world', description: 'Say hello.', parameters: { type: 'object', properties: { who: { type: 'string' } } } },
      async run(args: any) { return { ok: true, output: `hello ${args.who ?? 'world'} (${ctx.config.greeting ?? 'hi'})` }; },
    });
    ctx.registerPersonaDir(join(here, 'personas'));
    ctx.registerSink({ name: 'hello-sink', async send(n: any) { sent.push(n); } });
    ctx.registerRoute('get', '/ping', (_req: any, res: any) => res.json({ pong: true, greeting: ctx.config.greeting }));
    ctx.onEvent((e: any) => { if (e.kind === 'goal_created') ctx.log(`saw goal ${e.goalId}`); });
  },
};
