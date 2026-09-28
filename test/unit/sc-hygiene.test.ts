// SC hygiene: secret redaction, private file modes, dispatch traversal, review symlink escape.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, statSync, symlinkSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/store.js';
import { secretsFromEnv, makeRedactor, envRedactor } from '../../src/redact.js';
import { backupPrivate, writePrivateFile, writePrivateFileAtomic } from '../../src/secure-fs.js';
import { putConfigFile, redactConfigContent, containsRedaction } from '../../src/ops/config-files.js';
import { getDispatch } from '../../src/ops/dispatch.js';
import { readWorkspaceFile, listWorkspace } from '../../src/review/files.js';
import { ToolRegistry } from '../../src/runtime/tools.js';

const mode = (p: string) => statSync(p).mode & 0o777;
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

describe('redactor', () => {
  const env = {
    ALFRED_TOKEN: 'alfred-token-123456',
    SLACK_BOT_TOKEN: 'xoxb-1111-2222-abcdef',
    SLACK_CHANNEL: 'C0123456789',
    TWILIO_ACCOUNT_SID: 'AC00000000000000',
    OPENAI_API_KEY: 'sk-proj-abcdefgh',
    DB_PASSWORD: 'hunter22hunter22',
    MY_SECRET: 'short', // < 8 chars: ignored
    ALFRED_TOKEN_FILE: '/home/q/.config/alfred.env', // a location, not a secret
    HOME: '/home/quinna',
    GIT_AUTHOR_NAME: 'Quinn Yates',
  };
  it('picks secret-looking env vars with long values', () => {
    const names = secretsFromEnv(env).map((s) => s.name).sort();
    expect(names).toEqual(['ALFRED_TOKEN', 'DB_PASSWORD', 'OPENAI_API_KEY', 'SLACK_BOT_TOKEN', 'SLACK_CHANNEL', 'TWILIO_ACCOUNT_SID']);
  });
  it('replaces values recursively and leaves other data alone', () => {
    const r = makeRedactor(secretsFromEnv(env));
    const input = { out: `ALFRED_TOKEN=${env.ALFRED_TOKEN}\nKEY=${env.OPENAI_API_KEY}`, list: [env.DB_PASSWORD, 3, null], nested: { a: { b: env.SLACK_BOT_TOKEN } }, home: env.HOME };
    const out = r(input);
    expect(out.out).toBe('ALFRED_TOKEN=«redacted:ALFRED_TOKEN»\nKEY=«redacted:OPENAI_API_KEY»');
    expect(out.list).toEqual(['«redacted:DB_PASSWORD»', 3, null]);
    expect(out.nested.a.b).toBe('«redacted:SLACK_BOT_TOKEN»');
    expect(out.home).toBe('/home/quinna');
    expect(input.out).toContain(env.ALFRED_TOKEN); // input not mutated
    const plain = { x: 'nothing here' };
    expect(r(plain)).toBe(plain);
    expect(makeRedactor([])('abc')).toBe('abc');
  });
  it('is applied by the store to events, notes and results', () => {
    const store = openStore(':memory:', { redact: envRedactor(env) });
    const g = store.createGoal({ title: 'g' } as any);
    const t = store.createTask({ goalId: g.id, title: 't', persona: 'coder' } as any);
    const ev = store.appendEvent(g.id, t.id, 'tool', { name: 'shell', output: `env\nSLACK_BOT_TOKEN=${env.SLACK_BOT_TOKEN}` });
    expect(ev.data.output).toContain('«redacted:SLACK_BOT_TOKEN»');
    const stored = store.events(g.id).find((e) => e.id === ev.id)!;
    expect(JSON.stringify(stored.data)).not.toContain(env.SLACK_BOT_TOKEN);
    store.appendNote(t.id, `pw ${env.DB_PASSWORD}`);
    store.setResult(t.id, `key ${env.OPENAI_API_KEY}`);
    const task = store.getTask(t.id)!;
    expect(task.notes).toContain('«redacted:DB_PASSWORD»');
    expect(task.result).toBe('key «redacted:OPENAI_API_KEY»');
    store.close();
  });
});

describe('private file modes', () => {
  it('openStore chmods the DB and its WAL/SHM to 0600', () => {
    const d = tmp('sc-db-');
    const p = join(d, 'a.db');
    writeFileSync(p, '');
    const s = openStore(p);
    s.appendEvent('', null, 'ops', { a: 1 });
    s.close();
    const s2 = openStore(p);
    for (const f of readdirSync(d)) expect(mode(join(d, f)), f).toBe(0o600);
    s2.close();
  });
  it('writePrivateFile / atomic / backups are 0600 in 0700 dirs', () => {
    const d = tmp('sc-fs-');
    const f = join(d, 'mcp.json');
    writeFileSync(f, '{}', { mode: 0o644 });
    writePrivateFile(f, '{"a":1}');
    expect(mode(f)).toBe(0o600);
    writePrivateFileAtomic(f, '{"b":1}');
    expect(mode(f)).toBe(0o600);
    expect(readFileSync(f, 'utf8')).toBe('{"b":1}');
    const bdir = join(d, '.alfred-backup');
    const bak = backupPrivate(f, bdir, join('config', 'mcp.json.1'));
    expect(mode(bak)).toBe(0o600);
    expect(mode(bdir)).toBe(0o700);
    expect(mode(join(bdir, 'config'))).toBe(0o700);
  });
  it('config editor writes and backups are 0600', () => {
    const root = tmp('sc-cfg-');
    const repoRoot = join(root, 'repo');
    mkdirSync(join(repoRoot, 'config'), { recursive: true });
    writeFileSync(join(repoRoot, 'config', 'alfred.local.yaml'), 'server:\n  port: 1\n', { mode: 0o644 });
    const deps: any = { repoRoot, personasDir: join(root, 'personas'), registry: new ToolRegistry(), env: {} };
    const backupDir = join(root, 'bak');
    putConfigFile(deps, backupDir, 'config/alfred.local.yaml', 'server:\n  port: 2\n');
    expect(mode(join(repoRoot, 'config', 'alfred.local.yaml'))).toBe(0o600);
    const baks = readdirSync(join(backupDir, 'config'));
    expect(baks.length).toBe(1);
    expect(mode(join(backupDir, 'config', baks[0]!))).toBe(0o600);
    expect(mode(backupDir)).toBe(0o700);
  });
});

describe('config file secrets', () => {
  it('masks literal secrets but keeps ${ENV} references and harmless values', () => {
    const yaml = 'server:\n  port: 8790\n  token: abcdef123456\nslack:\n  botToken: "xoxb-123-456"\n  maxTokens: 4096\n  apiKey: ${OPENAI_API_KEY}\n';
    const json = '{\n  "servers": {\n    "x": { "headers": { "Authorization": "Bearer ${X_TOKEN}" } },\n    "y": { "headers": { "Authorization": "Bearer literal-secret-value" } },\n    "z": { "env": { "API_KEY": "sk-live-9999999" } }\n  }\n}\n';
    const y = redactConfigContent(yaml);
    expect(y.redacted).toBe(true);
    expect(y.content).toContain('token: «redacted»');
    expect(y.content).toContain('botToken: "«redacted»"');
    expect(y.content).toContain('maxTokens: 4096');
    expect(y.content).toContain('apiKey: ${OPENAI_API_KEY}');
    const j = redactConfigContent(json);
    expect(j.content).toContain('Bearer ${X_TOKEN}');
    expect(j.content).not.toContain('literal-secret-value');
    expect(j.content).not.toContain('sk-live-9999999');
    expect(() => JSON.parse(j.content)).not.toThrow();
    const env = redactConfigContent('note: hello xoxb-env-secret-1\n', envRedactor({ SLACK_BOT_TOKEN: 'xoxb-env-secret-1' }));
    expect(env.content).toBe('note: hello «redacted:SLACK_BOT_TOKEN»\n');
    expect(redactConfigContent('server:\n  port: 1\n').redacted).toBe(false);
  });
  it('a PUT that still carries a mask is refused (it would overwrite the real secret)', () => {
    const root = tmp('sc-cfg2-');
    mkdirSync(join(root, 'config'), { recursive: true });
    const deps: any = { repoRoot: root, personasDir: join(root, 'p'), registry: new ToolRegistry(), env: {} };
    expect(containsRedaction('token: «redacted»')).toBe(true);
    expect(() => putConfigFile(deps, join(root, 'bak'), 'config/alfred.local.yaml', 'token: «redacted»\n')).toThrow(/redacted/);
  });
});

describe('dispatch traversal', () => {
  it('getDispatch refuses names outside ^[A-Za-z0-9_-]+$', () => {
    const root = tmp('sc-disp-');
    const dispatchDir = join(root, 'dispatch');
    mkdirSync(join(dispatchDir, 'ok'), { recursive: true });
    writeFileSync(join(dispatchDir, 'ok', 'status.json'), JSON.stringify({ name: 'ok', state: 'done' }));
    mkdirSync(join(root, 'outside'));
    writeFileSync(join(root, 'outside', 'status.json'), JSON.stringify({ name: 'secret' }));
    writeFileSync(join(root, 'outside', 'run.log'), 'SECRET\n');
    expect(getDispatch(dispatchDir, 'ok')?.status?.name).toBe('ok');
    expect(getDispatch(dispatchDir, '../outside')).toBeNull();
    expect(getDispatch(dispatchDir, '..')).toBeNull();
    expect(getDispatch(dispatchDir, 'a/b')).toBeNull();
  });
});

describe('review files: symlink escape', () => {
  it('refuses reads and listings through symlinks that leave the workspace', async () => {
    const root = tmp('sc-ws-');
    const ws = join(root, 'ws');
    mkdirSync(join(ws, 'src'), { recursive: true });
    writeFileSync(join(ws, 'src', 'a.txt'), 'inside');
    mkdirSync(join(root, 'secret'));
    writeFileSync(join(root, 'secret', 'id_rsa'), 'PRIVATE');
    symlinkSync(join(root, 'secret'), join(ws, 'leak'));
    symlinkSync(join(root, 'secret', 'id_rsa'), join(ws, 'key'));
    symlinkSync(join(ws, 'src', 'a.txt'), join(ws, 'inner'));
    const ref = { workspace: ws, node: 'local' };
    const nodes: any = {};
    expect((await readWorkspaceFile(nodes, ref, 'src/a.txt')).content).toBe('inside');
    expect((await readWorkspaceFile(nodes, ref, 'inner')).content).toBe('inside'); // in-workspace link is fine
    await expect(readWorkspaceFile(nodes, ref, 'key')).rejects.toMatchObject({ status: 400 });
    await expect(readWorkspaceFile(nodes, ref, 'leak/id_rsa')).rejects.toMatchObject({ status: 400 });
    await expect(listWorkspace(nodes, ref, 'leak')).rejects.toMatchObject({ status: 400 });
    await expect(readWorkspaceFile(nodes, ref, '../secret/id_rsa')).rejects.toMatchObject({ status: 400 });
    await expect(readWorkspaceFile(nodes, ref, 'missing.txt')).rejects.toMatchObject({ status: 404 });
    expect((await listWorkspace(nodes, ref, '.')).entries.map((e) => e.name)).toContain('src');
  });
});

