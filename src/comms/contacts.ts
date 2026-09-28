// P21b §1 — Quinn's contacts: config/contacts.yaml ([{name, phone?, email?, imessage?, notes?}]),
// read fresh on every call, validated and backed up on every write.
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { ModuleDeps } from '../modules.js';
import { powersRoot } from '../powers/gate.js';
import { normalizeHandle, normalizePhone } from '../node/protocol.js';

export interface Contact {
  name: string;
  phone?: string;
  email?: string;
  imessage?: string;
  notes?: string;
}

const MAX_CONTACTS = 2000;
const EMAIL_RE = /^[^\s@"'<>]+@[^\s@"'<>]+\.[^\s@"'<>]+$/;
const CTRL_RE = /[\x00-\x1f\x7f]/;

export function contactsPath(deps: ModuleDeps): string {
  return join(powersRoot(deps), 'config', 'contacts.yaml');
}

/** Validate one entry; returns it normalized (numbers stripped to +digits). Throws Error(reason). */
export function validateContact(input: any, i = 0): Contact {
  const where = `contact ${i + 1}`;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${where}: must be an object`);
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 80 || CTRL_RE.test(name)) throw new Error(`${where}: name is required (≤ 80 characters, one line)`);
  const out: Contact = { name };
  const str = (k: string) => (input[k] === undefined || input[k] === null || input[k] === '' ? undefined : String(input[k]).trim());
  const phone = str('phone');
  if (phone !== undefined) {
    const p = normalizePhone(phone);
    if (!p) throw new Error(`${name}: invalid phone "${phone}" (use digits with an optional leading +, e.g. +15551234567)`);
    out.phone = p;
  }
  const email = str('email');
  if (email !== undefined) {
    if (email.length > 254 || !EMAIL_RE.test(email) || CTRL_RE.test(email)) throw new Error(`${name}: invalid email "${email}"`);
    out.email = email;
  }
  const imessage = str('imessage');
  if (imessage !== undefined) {
    const h = normalizeHandle(imessage);
    if (!h) throw new Error(`${name}: invalid imessage handle "${imessage}" (a phone number or an email)`);
    out.imessage = h;
  }
  const notes = str('notes');
  if (notes !== undefined) {
    if (notes.length > 1000) throw new Error(`${name}: notes must be ≤ 1000 characters`);
    out.notes = notes;
  }
  return out;
}

/** Validate a whole list: every entry valid, names unique (case-insensitive). Throws Error(reason). */
export function validateContacts(input: unknown): Contact[] {
  if (!Array.isArray(input)) throw new Error('contacts must be a list');
  if (input.length > MAX_CONTACTS) throw new Error(`at most ${MAX_CONTACTS} contacts`);
  const list = input.map((c, i) => validateContact(c, i));
  const seen = new Set<string>();
  for (const c of list) {
    const k = c.name.toLowerCase();
    if (seen.has(k)) throw new Error(`duplicate contact name: ${c.name}`);
    seen.add(k);
  }
  return list;
}

/** The file, read fresh. Missing = no contacts; broken entries are skipped (the file is Quinn's). */
export function loadContacts(deps: ModuleDeps): Contact[] {
  const path = contactsPath(deps);
  if (!existsSync(path)) return [];
  let raw: any;
  try {
    raw = parseYaml(readFileSync(path, 'utf8'));
  } catch (e: any) {
    throw new Error(`config/contacts.yaml is not valid YAML: ${e?.message ?? e}`);
  }
  const items: unknown[] = Array.isArray(raw) ? raw : Array.isArray(raw?.contacts) ? raw.contacts : [];
  const out: Contact[] = [];
  items.forEach((c, i) => {
    try {
      out.push(validateContact(c, i));
    } catch {
      /* skip a bad entry; the UI shows the valid ones and a save rewrites the file cleanly */
    }
  });
  return out;
}

/** Validate, back up the old file, write atomically. Returns the saved list. */
export function saveContacts(deps: ModuleDeps, input: unknown): Contact[] {
  const list = validateContacts(input);
  const path = contactsPath(deps);
  if (existsSync(path)) {
    const backupDir = (deps.extra?.backupDir as string | undefined) ?? join(powersRoot(deps), '.alfred-backup');
    const bak = join(backupDir, 'config', `contacts.yaml.${Date.now()}`);
    mkdirSync(dirname(bak), { recursive: true });
    cpSync(path, bak);
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, list.length ? stringifyYaml(list) : '[]\n', { mode: 0o600 });
  renameSync(tmp, path);
  return list;
}

export type Resolved = { ok: true; name?: string; number?: string; handle?: string } | { ok: false, error: string };

/** A raw number (E.164-ish) or a contact name, case-insensitive: exact match, else a unique partial match. */
export function findContacts(list: Contact[], q: string): Contact[] {
  const k = q.trim().toLowerCase();
  if (!k) return [];
  const exact = list.filter((c) => c.name.toLowerCase() === k);
  if (exact.length) return exact;
  return list.filter((c) => c.name.toLowerCase().includes(k));
}

/**
 * `to` → who to reach: a number is used as-is (named when it is a contact's number);
 * a name must match exactly one contact. `need` picks the field: 'phone' (calls, SMS)
 * or 'messages' (phone, else the iMessage handle).
 */
export function resolveRecipient(list: Contact[], to: unknown, need: 'phone' | 'messages'): Resolved {
  const raw = typeof to === 'string' ? to.trim() : '';
  if (!raw) return { ok: false, error: 'to is required (a contact name or a number like +15551234567)' };
  if (/^[+\d\s().-]+$/.test(raw)) {
    const number = normalizePhone(raw);
    if (!number) return { ok: false, error: `invalid phone number: ${raw} (use digits with an optional leading +, e.g. +15551234567)` };
    const c = list.find((x) => x.phone === number);
    return { ok: true, ...(c ? { name: c.name } : {}), number, handle: number };
  }
  const hits = findContacts(list, raw);
  if (!hits.length) return { ok: false, error: `no contact named "${raw}" — add them in System → Contacts, or give a number` };
  if (hits.length > 1) return { ok: false, error: `"${raw}" is ambiguous: ${hits.slice(0, 8).map((c) => c.name).join(', ')} — use the full name or a number` };
  const c = hits[0];
  const handle = c.phone ?? (need === 'messages' ? c.imessage : undefined);
  if (!handle) return { ok: false, error: `${c.name} has no ${need === 'phone' ? 'phone number' : 'phone number or iMessage handle'} in contacts` };
  return { ok: true, name: c.name, ...(c.phone ? { number: c.phone } : {}), handle };
}

export function fmtContact(c: Contact): string {
  const bits = [c.phone, c.imessage && c.imessage !== c.phone ? `iMessage ${c.imessage}` : undefined, c.email].filter(Boolean);
  return `${c.name}${bits.length ? ` — ${bits.join(', ')}` : ''}${c.notes ? ` (${c.notes.slice(0, 200)})` : ''}`;
}
