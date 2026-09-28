// P21b unit tests: contacts validation/resolution, the node's comms ops (argv, validation, caps),
// NodeHub.call, powers.yaml `to:` pre-approval, chat confirm, and the /contacts routes.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeHub } from '../../src/node/hub.js';
import { commsArgv, connectNode, MESSAGES_SCRIPT } from '../../src/node/client.js';
import { normalizeHandle, normalizePhone } from '../../src/node/protocol.js';
import { resolveRecipient, validateContacts, type Contact } from '../../src/comms/contacts.js';
import { startAlfred } from '../../src/main.js';
import type { LLM } from '../../src/runtime/contract.js';

const until = async (f: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('phone numbers and handles', () => {
  it('normalizes E.164-ish numbers and refuses anything else', () => {
    expect(normalizePhone('+1 (555) 000-1111')).toBe('+15550001111');
    expect(normalizePhone('555.000.1111')).toBe('5550001111');
    for (const bad of ['', '+', 'abc', '+1555;rm', '++1555', '1'.repeat(16), '+1555\n1', 'tel:+1555']) expect(normalizePhone(bad)).toBeNull();
    expect(normalizeHandle('sam@example.com')).toBe('sam@example.com');
    expect(normalizeHandle('a"b@example.com')).toBeNull();
    expect(normalizeHandle('a b@example.com')).toBeNull();
  });
});

describe('contacts', () => {
  const list: Contact[] = [
    { name: 'Mom', phone: '+15550001111' },
    { name: 'Sam Rivera', phone: '+15550002222' },
    { name: 'Sam Lee', phone: '+15550003333' },
    { name: 'Pat', imessage: 'pat@example.com' },
  ];

  it('resolves names case-insensitively, refuses ambiguous and unknown names', () => {
    expect(resolveRecipient(list, 'mom', 'messages')).toMatchObject({ ok: true, name: 'Mom', handle: '+15550001111' });
    expect(resolveRecipient(list, 'sam rivera', 'phone')).toMatchObject({ ok: true, number: '+15550002222' });
    expect(resolveRecipient(list, 'rivera', 'phone')).toMatchObject({ ok: true, name: 'Sam Rivera' });
    const amb = resolveRecipient(list, 'sam', 'phone');
    expect(amb.ok).toBe(false);
    expect((amb as any).error).toMatch(/ambiguous.*Sam Rivera.*Sam Lee/);
    expect(resolveRecipient(list, 'nobody', 'phone')).toMatchObject({ ok: false });
    expect(resolveRecipient(list, '', 'phone')).toMatchObject({ ok: false });
  });

  it('takes numbers as-is (named when known), and refuses bad ones', () => {
    expect(resolveRecipient(list, '+1 555 000 2222', 'phone')).toMatchObject({ ok: true, name: 'Sam Rivera', number: '+15550002222' });
    expect(resolveRecipient(list, '+15559999999', 'phone')).toMatchObject({ ok: true, number: '+15559999999' });
    expect(resolveRecipient(list, '(+)-', 'phone').ok).toBe(false);
  });

  it('uses the iMessage handle for texts only', () => {
    expect(resolveRecipient(list, 'pat', 'messages')).toMatchObject({ ok: true, handle: 'pat@example.com' });
    expect(resolveRecipient(list, 'pat', 'phone').ok).toBe(false);
  });

  it('validates a list: fields, duplicates', () => {
    expect(validateContacts([{ name: ' Mom ', phone: '+1 555 000 1111' }])).toEqual([{ name: 'Mom', phone: '+15550001111' }]);
    expect(() => validateContacts([{ name: 'A', phone: 'call me' }])).toThrow(/invalid phone/);
    expect(() => validateContacts([{ name: 'A' }, { name: 'a' }])).toThrow(/duplicate/);
    expect(() => validateContacts([{ phone: '+1555' }])).toThrow(/name is required/);
    expect(() => validateContacts([{ name: 'A', email: 'nope' }])).toThrow(/invalid email/);
    expect(() => validateContacts({})).toThrow(/list/);
  });
});

describe('node comms ops', () => {
  it('passes recipient and text as separate argv elements to a fixed script', () => {
    const evil = '" & (do shell script "touch /tmp/pwned") & "';
    const [file, argv] = commsArgv('sendMessage', { to: '+15550001111', text: evil });
    expect(file).toBe('osascript');
    expect(argv).toEqual(['-e', MESSAGES_SCRIPT, '--', '+15550001111', evil]);
    expect(MESSAGES_SCRIPT).not.toContain('+1555');
    expect(MESSAGES_SCRIPT).toContain('on run argv');
    expect(commsArgv('placeCall', { to: '+15550001111' })).toEqual(['open', ['tel:+15550001111']]);
  });

  let server: Server;
  let hub: NodeHub;
  let url = '';
  const ran: any[] = [];
  const handles: { close(): void }[] = [];
  beforeAll(async () => {
    server = createServer();
    hub = new NodeHub();
    hub.attach(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `ws://127.0.0.1:${(server.address() as any).port}`;
    const runner = { run: async (op: any, args: any) => (ran.push({ op, args }), { ok: true }) };
    handles.push(connectNode({ url, name: 'plain', roots: [tmpdir()], caps: ['fs'], reconnect: false, comms: runner }));
    handles.push(connectNode({ url, name: 'mac', roots: [tmpdir()], caps: ['fs', 'messages', 'calls'], reconnect: false, comms: runner }));
    await until(() => hub.list().length === 2);
  });
  afterAll(async () => {
    for (const h of handles) h.close();
    hub.close();
    await new Promise((r) => server.close(r));
  });

  it('picks the node with the cap and runs the op through the injected runner', async () => {
    expect(hub.withCap('messages')?.name).toBe('mac');
    expect(hub.withCap('nope')).toBeNull();
    expect(await hub.call('mac', 'sendMessage', { to: '+1 555 000 1111', text: 'hi' })).toEqual({ ok: true });
    expect(ran.at(-1)).toEqual({ op: 'sendMessage', args: { to: '+15550001111', text: 'hi' } });
    expect(await hub.call('mac', 'placeCall', { to: '+15550001111' })).toEqual({ ok: true });
    expect(ran.at(-1)).toEqual({ op: 'placeCall', args: { to: '+15550001111' } });
  });

  it('refuses without the cap, with bad input, or offline — never reaching the runner', async () => {
    const n = ran.length;
    expect(await hub.call('plain', 'sendMessage', { to: '+15550001111', text: 'hi' })).toMatchObject({ ok: false, error: expect.stringMatching(/--messages/) });
    expect((await hub.call('mac', 'placeCall', { to: '+1555; open -a Calculator' })).ok).toBe(false);
    expect((await hub.call('mac', 'placeCall', { to: '-a Calculator' })).ok).toBe(false);
    expect((await hub.call('mac', 'sendMessage', { to: '+15550001111', text: '' })).ok).toBe(false);
    expect((await hub.call('mac', 'sendMessage', { to: '+15550001111', text: 'x'.repeat(5000) })).ok).toBe(false);
    expect((await hub.call('gone', 'sendMessage', { to: '+15550001111', text: 'hi' })).ok).toBe(false);
    expect((await hub.call('gone', 'sendMessage', { to: '+15550001111', text: 'hi' })).uncertain).toBeUndefined();
    expect(ran.length).toBe(n);
  });

  it('a node that drops after receiving the request reports UNCERTAIN (it may have sent), not a plain failure', async () => {
    let dropper: { close(): void } | null = null;
    const runner = { run: async () => { dropper!.close(); return new Promise<any>(() => {}); } }; // "sends", then the link dies
    dropper = connectNode({ url, name: 'flaky', roots: [tmpdir()], caps: ['fs', 'messages'], reconnect: false, comms: runner });
    await until(() => hub.list().some((x) => x.name === 'flaky'));
    const r = await hub.call('flaky', 'sendMessage', { to: '+15550001111', text: 'hi' }, 5000);
    expect(r).toMatchObject({ ok: false, uncertain: true });
    expect(r.error).toMatch(/before confirming/);
  });
});

const idle: LLM = { async chat() { return { content: '', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 } }; } };

describe('comms module: policy, chat, routes', () => {
  let alfred: Awaited<ReturnType<typeof startAlfred>>;
  let repoRoot = '';
  let base = '';
  const sent: any[] = [];
  let node: { close(): void; connected(): boolean };
  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), 'alfred-p21b-unit-'));
    repoRoot = join(base, 'repo');
    mkdirSync(join(repoRoot, 'config'), { recursive: true });
    cpSync('config/models.yaml', join(repoRoot, 'config', 'models.yaml'));
    writeFileSync(join(repoRoot, 'config', 'contacts.yaml'), '- name: Mom\n  phone: "+15550001111"\n- name: Dad\n  phone: "+15550004444"\n');
    writeFileSync(join(repoRoot, 'config', 'powers.yaml'), 'autoApprove:\n  - action: message\n    to: ["mom"]\n');
    alfred = await startAlfred({
      dbPath: join(base, 'a.db'), mirrorDir: join(base, 'vault'), workRoot: join(base, 'work'), personasDir: 'personas',
      port: 0, host: '127.0.0.1', pollMs: 25, deck: null, env: { ALFRED_NOTIFY_DESKTOP: '0' }, llm: idle, gitRoot: join(base, 'git'),
      extra: { repoRoot, llm: idle, backupDir: join(base, 'bak') },
    });
    node = connectNode({
      url: alfred.url.replace('http', 'ws'), name: 'mac', roots: [base], caps: ['messages', 'calls'], reconnect: false,
      comms: { run: async (op: any, args: any) => (sent.push({ op, args }), { ok: true }) },
    });
    await until(() => node.connected() && alfred.nodes.list().length > 0);
  }, 60_000);
  afterAll(async () => {
    node?.close();
    await alfred?.stop();
  });

  const tool = (name: string) => (alfred.modules.comms as any).tools.find((t: any) => t.schema.name === name);
  const ctx = (taskId: string) => ({ taskId, goalId: '', workspace: base, persona: 'alfred', signal: new AbortController().signal, acceptance: [], progress: () => {} });

  it('powers.yaml `to:` pre-approves a contact by name (any case); others still need approval', async () => {
    const g = alfred.store.createGoal({ title: 'x' });
    const t = alfred.store.createTask({ goalId: g.id, persona: 'alfred', title: 'x' });
    const r = await tool('message').run({ to: 'MOM', text: 'on my way' }, ctx(t.id));
    expect(r.ok).toBe(true);
    expect(sent.at(-1)).toEqual({ op: 'sendMessage', args: { to: '+15550001111', text: 'on my way' } });
    const d = await tool('message').run({ to: 'Dad', text: 'on my way' }, ctx(t.id));
    expect(d.park).toBeTruthy();
    const ev = alfred.store.allEvents().filter((e) => e.kind === 'comms');
    expect(ev.at(-1)!.data).toEqual({ kind: 'message', to: '+15550001111', provider: 'node:mac', ok: true });
  });

  it('in chat asks first, runs with confirm:true; refuses ambiguous/unknown recipients up front', async () => {
    const n = sent.length;
    const ask = await tool('call').run({ to: 'dad' }, ctx('chat:1'));
    expect(ask.ok).toBe(false);
    expect(ask.output).toMatch(/needs Quinn’s OK: call: call to Dad \(\+15550004444\)/);
    expect(sent.length).toBe(n);
    const ok = await tool('call').run({ to: 'dad', confirm: true }, ctx('chat:1'));
    expect(ok.ok).toBe(true);
    expect(ok.output).toMatch(/click Call/);
    expect(sent.at(-1)).toEqual({ op: 'placeCall', args: { to: '+15550004444' } });
    expect((await tool('message').run({ to: 'Grandma', text: 'hi' }, ctx('chat:1'))).output).toMatch(/no contact/);
    expect((await tool('call').run({ to: 'Mom', say: 'hi' }, ctx('chat:1'))).output).toMatch(/Twilio/);
  });

  it('GET/PUT /contacts validates, backs up and writes the file', async () => {
    const h = { 'content-type': 'application/json' };
    const got = await (await fetch(`${alfred.url}/api/contacts`)).json();
    expect(got.map((c: any) => c.name)).toEqual(['Mom', 'Dad']);
    expect((await fetch(`${alfred.url}/api/contacts`, { method: 'PUT', headers: h, body: JSON.stringify({ contacts: [] }) })).status).toBe(400);
    const bad = await fetch(`${alfred.url}/api/contacts`, { method: 'PUT', headers: h, body: JSON.stringify({ confirm: true, contacts: [{ name: 'X', phone: 'nope' }] }) });
    expect(bad.status).toBe(400);
    const ok = await fetch(`${alfred.url}/api/contacts`, {
      method: 'PUT', headers: h, body: JSON.stringify({ confirm: true, contacts: [...got, { name: 'Sam', phone: '+1 (555) 000-9999', notes: 'neighbor' }] }),
    });
    expect(ok.status).toBe(200);
    expect(readFileSync(join(repoRoot, 'config', 'contacts.yaml'), 'utf8')).toContain('+15550009999');
    expect(existsSync(join(base, 'bak', 'config')) && readdirSync(join(base, 'bak', 'config')).some((f) => f.startsWith('contacts.yaml.'))).toBe(true);
    expect((await tool('contacts').run({ op: 'find', q: 'sam' }, ctx('chat:1'))).output).toContain('neighbor');
  });
});
