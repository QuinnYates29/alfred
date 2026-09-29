// V1 unit tests — node-side vault helpers: containment, ops, caps, and the rule that the
// vault is NOT a general root (plain readFile/writeFile with a vault path are refused).
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  vaultResolve, vaultMustResolve, vaultList, vaultRead, vaultSearch, vaultWrite, vaultAppend, vaultMove, VaultError,
} from '../../src/node/vault.js';
import { handleOp, expandHome } from '../../src/node/client.js';

let dir: string; // the vault
let out: string; // a folder OUTSIDE the vault (symlink escape target)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'alfred-vault-'));
  out = mkdtempSync(join(tmpdir(), 'alfred-out-'));
  mkdirSync(join(dir, 'Alfred'), { recursive: true });
  mkdirSync(join(dir, '.obsidian'), { recursive: true });
  writeFileSync(join(dir, 'Alfred', 'note.md'), '# Note\nhello vault');
  writeFileSync(join(dir, '.obsidian', 'config.md'), 'secret');
  writeFileSync(join(out, 'outside.md'), 'outside the vault');
  symlinkSync(out, join(dir, 'link'));
});

describe('vaultResolve', () => {
  it('resolves plain vault-relative paths', () => {
    expect(vaultResolve(dir, 'Alfred/note.md')).toBe(join(dir, 'Alfred', 'note.md'));
  });
  it('refuses .., absolute paths, drive paths, NULs and empty', () => {
    for (const bad of ['../etc/passwd', 'Alfred/../../x.md', '/etc/passwd', 'C:\\vault\\x.md', '', 'a\0b']) {
      expect(vaultResolve(dir, bad), bad).toBeNull();
    }
    expect(vaultResolve(dir, undefined)).toBeNull();
    expect(vaultResolve(dir, 42)).toBeNull();
  });
  it('refuses hidden segments (.obsidian, .trash, .git, any dot name)', () => {
    for (const bad of ['.obsidian/config.md', 'Alfred/.git/x.md', 'a/.trash/b.md', '.hidden/x.md']) {
      expect(vaultResolve(dir, bad), bad).toBeNull();
    }
  });
  it('refuses symlink escapes (realpath containment)', () => {
    expect(vaultResolve(dir, 'link/outside.md')).toBeNull();
    expect(vaultResolve(dir, 'link/outside.md', { write: true })).toBeNull();
  });
  it('md flag: non-.md refused when required, allowed when not', () => {
    expect(vaultResolve(dir, 'Alfred/notes.txt', { md: true })).toBeNull();
    expect(vaultResolve(dir, 'Alfred/notes.txt')).not.toBeNull();
  });
  it('vaultMustResolve throws honest VaultErrors', () => {
    expect(() => vaultMustResolve(dir, '../x.md')).toThrow(VaultError);
    expect(() => vaultMustResolve(dir, 'x.txt', { md: true })).toThrow(/\.md/);
    expect(() => vaultMustResolve(dir, '.obsidian/x.md')).toThrow(/hidden/);
    expect(() => vaultMustResolve(dir, '/abs/x.md')).toThrow(/absolute/);
  });
});

describe('vault ops', () => {
  it('list: entries with dir/size/mtime, dot dirs skipped, recursive walks', () => {
    const flat = vaultList(dir, {});
    expect(flat.entries.map((e) => e.path)).toEqual(['Alfred', 'link']);
    const rec = vaultList(dir, { path: 'Alfred', recursive: true });
    expect(rec.entries.map((e) => e.path)).toEqual(['Alfred/note.md']); // paths stay vault-relative
    const e = vaultList(dir, { path: 'Alfred' }).entries[0]!;
    expect(e).toMatchObject({ path: 'Alfred/note.md', dir: false, size: 18 });
    expect(e.mtime).toBeGreaterThan(0);
    expect(() => vaultList(dir, { path: 'note.md' })).toThrow(/not a folder/);
  });
  it('read: content + mtime; md only; missing refused', () => {
    const r = vaultRead(dir, { path: 'Alfred/note.md' });
    expect(r.content).toContain('hello vault');
    expect(r.mtime).toBeGreaterThan(0);
    expect(() => vaultRead(dir, { path: 'Alfred/notes.txt' })).toThrow(/\.md/);
    expect(() => vaultRead(dir, { path: 'gone.md' })).toThrow(/no such page/);
  });
  it('read: > 1 MB refused', () => {
    writeFileSync(join(dir, 'big.md'), 'x'.repeat(1_000_001));
    expect(() => vaultRead(dir, { path: 'big.md' })).toThrow(/too large/);
  });
  it('search: case-insensitive substring over .md, line numbers, dot dirs skipped', () => {
    writeFileSync(join(dir, 'Other.md'), 'top\nHello There line\nbottom');
    writeFileSync(join(dir, '.obsidian', 'hello-hidden.md'), 'Hello There hidden');
    const hits = vaultSearch(dir, { query: 'hello there' }).hits;
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ path: 'Other.md', line: 2, text: 'Hello There line' });
    expect(vaultSearch(dir, { query: 'zzz-nothing' }).hits).toEqual([]);
    expect(() => vaultSearch(dir, { query: ' ' })).toThrow(/query/);
  });
  it('write: creates parent dirs; refuses overwrite without the flag; atomic', () => {
    const w = vaultWrite(dir, { path: 'Alfred/deep/page.md', content: '# P' });
    expect(w).toMatchObject({ path: 'Alfred/deep/page.md', bytes: 3 });
    expect(readFileSync(join(dir, 'Alfred', 'deep', 'page.md'), 'utf8')).toBe('# P');
    expect(() => vaultWrite(dir, { path: 'Alfred/deep/page.md', content: 'x' })).toThrow(/already exists/);
    expect(readFileSync(join(dir, 'Alfred', 'deep', 'page.md'), 'utf8')).toBe('# P');
    vaultWrite(dir, { path: 'Alfred/deep/page.md', content: '# P2', overwrite: true });
    expect(readFileSync(join(dir, 'Alfred', 'deep', 'page.md'), 'utf8')).toBe('# P2');
    // no tmp litter
    expect(existsSync(join(dir, 'Alfred', 'deep', '.tmp-x'))).toBe(false);
  });
  it('write: > 512 KB refused; append: newline-joined, creates when missing', () => {
    expect(() => vaultWrite(dir, { path: 'a.md', content: 'x'.repeat(512_001) })).toThrow(/too large/);
    vaultAppend(dir, { path: 'Alfred/note.md', content: 'more' });
    expect(readFileSync(join(dir, 'Alfred', 'note.md'), 'utf8')).toBe('# Note\nhello vault\nmore');
    vaultAppend(dir, { path: 'New.md', content: 'fresh' });
    expect(readFileSync(join(dir, 'New.md'), 'utf8')).toBe('fresh');
  });
  it('move: renames inside the vault, refuses missing source and existing target', () => {
    vaultMove(dir, { from: 'Alfred/note.md', to: 'Alfred/moved.md' });
    expect(existsSync(join(dir, 'Alfred', 'note.md'))).toBe(false);
    expect(readFileSync(join(dir, 'Alfred', 'moved.md'), 'utf8')).toContain('hello vault');
    expect(() => vaultMove(dir, { from: 'Alfred/note.md', to: 'x.md' })).toThrow(/no such page/);
    expect(() => vaultMove(dir, { from: 'Alfred/moved.md', to: 'Alfred/moved.md' })).toThrow(/already exists/);
    expect(() => vaultMove(dir, { from: 'Alfred/moved.md', to: '../out.md' })).toThrow(/\.\./);
  });
});

describe('node op routing (handleOp)', () => {
  const ctx = (caps: string[], vault?: string) => ({ caps, comms: { run: async () => ({ ok: true }) } as any, ...(vault ? { vault } : {}) });

  it('runs vault ops when the vault is configured', async () => {
    const r = await handleOp('1', 'vaultRead', { path: 'Alfred/note.md' }, ctx(['fs', 'vault'], dir));
    expect((await r).content).toContain('hello vault');
  });
  it('refuses vault ops without --vault or without the cap', async () => {
    await expect(handleOp('1', 'vaultRead', { path: 'Alfred/note.md' }, ctx(['fs']))).rejects.toThrow(/no vault/);
    await expect(handleOp('1', 'vaultList', {}, ctx([]))).rejects.toThrow(/not enabled|no vault/);
  });
  it('general fs ops with a path inside the vault dir are refused (the vault is not a root)', async () => {
    await expect(handleOp('1', 'readFile', { path: join(dir, 'Alfred', 'note.md') }, ctx(['fs', 'vault'], dir))).rejects.toThrow(/outside the allowed roots|vault/);
    await expect(handleOp('1', 'writeFile', { path: join(dir, 'x.md'), content: 'x' }, ctx(['fs', 'vault'], dir))).rejects.toThrow(/outside the allowed roots|vault/);
    await expect(handleOp('1', 'listDir', { path: dir }, ctx(['fs', 'vault'], dir))).rejects.toThrow(/outside the allowed roots|vault/);
    // …and the refusal is honest: the file was not touched
    expect(existsSync(join(dir, 'x.md'))).toBe(false);
    // a path outside the vault is not refused by the vault rule (roots guard answers it instead)
    await expect(handleOp('1', 'readFile', { path: join(out, 'outside.md') }, ctx(['fs', 'vault'], dir))).rejects.not.toThrow(/vault is only reachable/);
  });
  it('vault symlink at the edge stays refused', () => {
    expect(() => vaultRead(dir, { path: 'link/outside.md' })).toThrow(VaultError);
    expect(lstatSync(join(dir, 'link')).isSymbolicLink()).toBe(true);
  });
});

describe('CLI option parsing', () => {
  it('expandHome expands ~', () => {
    const home = process.env.HOME ?? '';
    expect(expandHome('~/Vault')).toBe(`${home}/Vault`);
    expect(expandHome('/abs/Vault')).toBe('/abs/Vault');
    expect(expandHome('~x/Vault')).toBe('~x/Vault');
  });
});
