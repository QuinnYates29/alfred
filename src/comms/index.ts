// P21b — people: contacts, texting, calling. Tools `contacts` (free), `message` and `call`
// (always behind the approval gate, action message/call, unless config/powers.yaml
// pre-approves the recipient with `to:`). Providers, first available wins:
//   texting: a node with cap `messages` (the Mac: Messages.app, SMS via the paired iPhone) → Twilio;
//   calling: `say` → Twilio TwiML; otherwise a node with cap `calls` (tel: handoff, Quinn clicks) → error.
// Every send/call is a `comms` system event {kind, to, provider, ok}; the text is only in the approval.
// Twilio credentials come from env and are never logged or echoed.
import express, { type Request, type Response } from 'express';
import type { AlfredModule, ModuleDeps } from '../modules.js';
import type { Tool, ToolContext, ToolResult } from '../runtime/contract.js';
import type { Store } from '../store.js';
import { storeForTask } from '../approvals.js';
import { gated, loadPolicy } from '../powers/gate.js';
import { MAX_MESSAGE_CHARS, normalizePhone } from '../node/protocol.js';
import { contactsPath, findContacts, fmtContact, loadContacts, resolveRecipient, saveContacts, type Contact } from './contacts.js';

const TWILIO_TIMEOUT_MS = 20_000;
const NO_TEXT_PROVIDER =
  'no way to send texts: run alfred-node on the Mac with --messages (Messages.app; SMS through the paired iPhone), ' +
  'or set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM in alfred’s env (Twilio)';

interface TwilioCreds {
  sid: string;
  token: string;
  from: string;
}

function twilioCreds(deps: ModuleDeps): TwilioCreds | null {
  const e = deps.env ?? {};
  const sid = e.TWILIO_ACCOUNT_SID?.trim();
  const token = e.TWILIO_AUTH_TOKEN?.trim();
  const from = e.TWILIO_FROM?.trim();
  return sid && token && from ? { sid, token, from } : null;
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** POST a form to Twilio's REST API. Never throws; errors never include the credentials. */
async function twilioPost(deps: ModuleDeps, c: TwilioCreds, resource: 'Messages' | 'Calls', form: Record<string, string>): Promise<{ ok: boolean; sid?: string; error?: string }> {
  const f: typeof fetch = (deps.extra?.fetch as typeof fetch | undefined) ?? fetch;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.sid)}/${resource}.json`;
  try {
    const res = await f(url, {
      method: 'POST',
      headers: {
        authorization: 'Basic ' + Buffer.from(`${c.sid}:${c.token}`).toString('base64'),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS),
    });
    let data: any = null;
    try {
      data = await res.json();
    } catch {
      /* empty body */
    }
    if (!res.ok) {
      const msg = typeof data?.message === 'string' ? data.message : `HTTP ${res.status}`;
      return { ok: false, error: `Twilio refused: ${msg.replaceAll(c.token, '***').slice(0, 300)}` };
    }
    return { ok: true, ...(typeof data?.sid === 'string' ? { sid: data.sid } : {}) };
  } catch (e: any) {
    return { ok: false, error: `Twilio unreachable: ${String(e?.message ?? e).slice(0, 200)}` };
  }
}

function record(deps: ModuleDeps, data: { kind: 'message' | 'call'; to: string; provider: string; ok: boolean }): void {
  try {
    deps.store.appendEvent('', null, 'comms', data);
  } catch {
    /* the event log must never break a tool */
  }
}

/**
 * The recipient string a powers.yaml `to:` rule names for this action (the contact's name,
 * any case, or its number in any formatting), so the gate's policy check can match it.
 */
function policyTo(deps: ModuleDeps, action: string, r: { name?: string; number?: string; handle?: string }): string | undefined {
  for (const rule of loadPolicy(deps).autoApprove) {
    if (rule.action !== action || !rule.to) continue;
    for (const t of rule.to) {
      if (r.name && t.trim().toLowerCase() === r.name.toLowerCase()) return t;
      const n = normalizePhone(t);
      if (n && (n === r.number || n === r.handle)) return t;
      if (t === r.handle) return t;
    }
  }
  return r.handle;
}

const who = (r: { name?: string; handle?: string }) => (r.name ? `${r.name} (${r.handle})` : `${r.handle}`);

function nodeWith(deps: ModuleDeps, cap: string): string | null {
  try {
    return deps.nodes?.withCap?.(cap)?.name ?? null;
  } catch {
    return null;
  }
}

function contactsTool(deps: ModuleDeps): Tool {
  return {
    kind: 'read',
    schema: {
      name: 'contacts',
      description: "Quinn's contacts (config/contacts.yaml). op find (q = name, part of a name, or number) | list.",
      parameters: {
        type: 'object',
        properties: { op: { type: 'string', enum: ['find', 'list'] }, q: { type: 'string' } },
        required: ['op'],
      },
    },
    async run(args: any): Promise<ToolResult> {
      try {
        const list = loadContacts(deps);
        const op = String(args?.op ?? '');
        if (op === 'list') return { ok: true, output: list.length ? list.slice(0, 200).map(fmtContact).join('\n') : 'no contacts (System → Contacts)' };
        if (op === 'find') {
          const q = String(args?.q ?? '').trim();
          if (!q) return { ok: false, output: 'q is required' };
          const n = normalizePhone(q);
          const hits = n ? list.filter((c) => c.phone === n || c.imessage === n) : findContacts(list, q);
          return { ok: true, output: hits.length ? hits.slice(0, 50).map(fmtContact).join('\n') : `no contact matches "${q}"` };
        }
        return { ok: false, output: `unknown op: ${op}` };
      } catch (e: any) {
        return { ok: false, output: `error: ${e?.message ?? String(e)}` };
      }
    },
  };
}

function messageTool(deps: ModuleDeps): Tool {
  return {
    kind: 'exec',
    schema: {
      name: 'message',
      description: 'Text someone (iMessage/SMS). to = contact name or number like +15551234567. Needs Quinn’s approval of the exact text.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['to', 'text'],
      },
    },
    async run(args: any, ctx: ToolContext): Promise<ToolResult> {
      try {
        const text = typeof args?.text === 'string' ? args.text.trim() : '';
        if (!text) return { ok: false, output: 'text is required' };
        if (text.length > MAX_MESSAGE_CHARS || text.includes('\0')) return { ok: false, output: `text must be ≤ ${MAX_MESSAGE_CHARS} characters` };
        const r = resolveRecipient(loadContacts(deps), args?.to, 'messages');
        if (!r.ok) return { ok: false, output: r.error };
        // Is there any way to send it? Don't ask Quinn to approve something nothing can deliver.
        const creds = twilioCreds(deps);
        if (!nodeWith(deps, 'messages') && !(creds && r.number)) {
          return { ok: false, output: creds ? `${who(r)} has no phone number for Twilio SMS; ${NO_TEXT_PROVIDER}` : NO_TEXT_PROVIDER };
        }
        const detail = `message to ${who(r)}: ${text}`;
        return await gated(
          { deps, tool: ctx },
          'message',
          detail,
          async () => {
            const node = nodeWith(deps, 'messages');
            if (node) {
              const res = await deps.nodes.call(node, 'sendMessage', { to: r.handle!, text });
              record(deps, { kind: 'message', to: r.handle!, provider: `node:${node}`, ok: res.ok, ...(res.uncertain ? { uncertain: true } : {}) });
              if (res.uncertain) {
                return { ok: false, output: `UNCONFIRMED: ${node} received the text for ${who(r)} but lost its connection before confirming — it may well have been sent. Do NOT retry; ask Quinn to check Messages first.` };
              }
              return res.ok
                ? { ok: true, output: `sent via ${node} (Messages) to ${who(r)}` }
                : { ok: false, output: `sending via ${node} (Messages) failed: ${res.error ?? 'unknown error'}` };
            }
            const c = twilioCreds(deps);
            if (!c || !r.number) return { ok: false, output: NO_TEXT_PROVIDER };
            const res = await twilioPost(deps, c, 'Messages', { To: r.number, From: c.from, Body: text });
            record(deps, { kind: 'message', to: r.number, provider: 'twilio', ok: res.ok });
            return res.ok
              ? { ok: true, output: `sent via Twilio SMS to ${who(r)}${res.sid ? ` (${res.sid})` : ''}` }
              : { ok: false, output: res.error ?? 'Twilio send failed' };
          },
          { to: policyTo(deps, 'message', r), logDetail: `message to ${who(r)} (${text.length} chars)` },
        );
      } catch (e: any) {
        return { ok: false, output: `error: ${e?.message ?? String(e)}` };
      }
    },
  };
}

function callTool(deps: ModuleDeps): Tool {
  return {
    kind: 'exec',
    schema: {
      name: 'call',
      description:
        'Phone someone. to = contact name or number. say = a spoken message (Twilio); without say the Mac hands the call to Quinn’s iPhone (he clicks Call). Needs approval.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          say: { type: 'string', description: 'text read aloud to the callee (Twilio)' },
        },
        required: ['to'],
      },
    },
    async run(args: any, ctx: ToolContext): Promise<ToolResult> {
      try {
        const say = typeof args?.say === 'string' ? args.say.trim() : '';
        if (say.length > MAX_MESSAGE_CHARS || say.includes('\0')) return { ok: false, output: `say must be ≤ ${MAX_MESSAGE_CHARS} characters` };
        const r = resolveRecipient(loadContacts(deps), args?.to, 'phone');
        if (!r.ok) return { ok: false, output: r.error };
        const creds = twilioCreds(deps);
        if (say && !creds) {
          return { ok: false, output: 'a spoken message (say) needs Twilio: set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM in alfred’s env; or call without say through the Mac (alfred-node --messages)' };
        }
        if (!say && !nodeWith(deps, 'calls')) {
          return {
            ok: false,
            output: creds
              ? 'Twilio can’t bridge a live call to Quinn: give say (a message read aloud), or run alfred-node on the Mac with --messages to hand the call to his iPhone'
              : 'no way to call: run alfred-node on the Mac with --messages (hands the call to the paired iPhone), or set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM (Twilio, with say)',
          };
        }
        const detail = `call to ${who(r)}${say ? ` saying: ${say}` : ''}`;
        return await gated(
          { deps, tool: ctx },
          'call',
          detail,
          async () => {
            if (say) {
              const c = twilioCreds(deps);
              if (!c) return { ok: false, output: 'Twilio is no longer configured' };
              const res = await twilioPost(deps, c, 'Calls', { To: r.number!, From: c.from, Twiml: `<Response><Say>${xml(say)}</Say></Response>` });
              record(deps, { kind: 'call', to: r.number!, provider: 'twilio', ok: res.ok });
              return res.ok
                ? { ok: true, output: `calling ${who(r)} via Twilio; it will say the message${res.sid ? ` (${res.sid})` : ''}` }
                : { ok: false, output: res.error ?? 'Twilio call failed' };
            }
            const node = nodeWith(deps, 'calls');
            if (!node) return { ok: false, output: 'the Mac (alfred-node --messages) is no longer connected' };
            const res = await deps.nodes.call(node, 'placeCall', { to: r.number! });
            record(deps, { kind: 'call', to: r.number!, provider: `node:${node}`, ok: res.ok, ...(res.uncertain ? { uncertain: true } : {}) });
            if (res.uncertain) {
              return { ok: false, output: `UNCONFIRMED: ${node} received the call request for ${who(r)} but lost its connection before confirming — the call may be ringing on the Mac. Do NOT retry; ask Quinn.` };
            }
            return res.ok
              ? { ok: true, output: `call to ${who(r)} handed to ${node} (iPhone via FaceTime) — Quinn must click Call on the Mac to connect` }
              : { ok: false, output: `calling via ${node} failed: ${res.error ?? 'unknown error'}` };
          },
          { to: policyTo(deps, 'call', r), logDetail: `call to ${who(r)}${say ? ' (with spoken message)' : ''}` },
        );
      } catch (e: any) {
        return { ok: false, output: `error: ${e?.message ?? String(e)}` };
      }
    },
  };
}

function commsRouter(deps: ModuleDeps): express.Router {
  const r = express.Router();
  r.get('/contacts', (_req: Request, res: Response) => {
    try {
      res.json(loadContacts(deps));
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  });
  r.put('/contacts', (req: Request, res: Response) => {
    const body = req.body ?? {};
    if (body.confirm !== true) {
      res.status(400).json({ error: 'confirm required' });
      return;
    }
    let saved: Contact[];
    try {
      saved = saveContacts(deps, body.contacts);
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? String(e) });
      return;
    }
    try {
      deps.store.appendEvent('', null, 'ops', { action: 'contacts.save', target: 'config/contacts.yaml', ok: true, by: body.by ?? 'api' });
    } catch {
      /* never break the response */
    }
    res.json({ ok: true, path: contactsPath(deps), contacts: saved });
  });
  return r;
}

/** Each running instance's tools, by its store (for the unbound stubs below). */
const bound = new WeakMap<Store, Tool[]>();

function buildTools(deps: ModuleDeps): Tool[] {
  return [contactsTool(deps), messageTool(deps), callTool(deps)];
}

export function createCommsModule(deps: ModuleDeps): AlfredModule {
  const tools = buildTools(deps);
  bound.set(deps.store, tools);
  return { name: 'comms', router: commsRouter(deps), tools };
}

/**
 * The same tools without a module (allTools(), for registries built outside startAlfred —
 * persona loading in tests): same schemas; a run finds the instance that owns the task's
 * store, or answers that comms is unavailable.
 */
export function commsToolStubs(): Tool[] {
  return buildTools({ extra: {} } as unknown as ModuleDeps).map((t) => ({
    ...t,
    run: async (args, ctx) => {
      const store = storeForTask(ctx.taskId);
      const real = store ? bound.get(store)?.find((x) => x.schema.name === t.schema.name) : undefined;
      return real ? real.run(args, ctx) : { ok: false, output: `${t.schema.name} is not available in this runtime` };
    },
  }));
}
