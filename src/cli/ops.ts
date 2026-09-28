// P19 — ops commands: stats, svc, qwen, logs, config, builds, nodes/models/personas, open.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Api, confirm, enc, flag, Parsed, print } from './util.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- stats ----

export async function cmdStats(api: Api, p: Parsed): Promise<void> {
  const s = await api.get('/stats');
  print(p, s, () => {
    const g = s.gpu;
    console.log(g
      ? `GPU ${g.name} ${g.utilPct}% ${g.tempC}C ${g.powerW}W mem ${g.memUsedMb ?? '?'}MB`
      : 'GPU none');
    const q = s.qwen ?? {};
    console.log(q.ok
      ? `Qwen ok ${q.busy ?? 0}/${q.total ?? 0} slots busy`
      : `Qwen down${q.error ? ` (${q.error})` : ''}`);
    const t = s.tokens?.last24h ?? {};
    console.log(`Tokens 24h ${t.prompt ?? 0} in / ${t.completion ?? 0} out (${t.turns ?? 0} turns)`);
    const tc = s.tasks ?? {};
    console.log(`Tasks ${Object.entries(tc).map(([k, n]) => `${k}=${n}`).join(' ') || 'none'}`);
    const h = s.host ?? {};
    console.log(`Host ${h.hostname ?? '?'} up ${h.uptimeS ?? 0}s load ${(h.load ?? []).map((x: number) => x.toFixed(2)).join(' ')} mem ${h.mem?.usedMb ?? '?'}/${h.mem?.totalMb ?? '?'}MB`);
  });
}

// ---- services ----

export async function cmdSvc(api: Api, p: Parsed): Promise<void> {
  const [action, name] = p.rest;
  if (!action) {
    const list = await api.get('/ops/services');
    return void print(p, list, () => {
      for (const s of list) {
        const since = s.since ? new Date(s.since).toISOString() : '-';
        console.log(`${s.name} ${s.active}/${s.sub} pid ${s.pid ?? '-'} since ${since}`);
      }
    });
  }
  if (!name) throw new Error(`usage: alfred svc <restart|start|stop> <name> [--force]`);
  if (!(await confirm(`${action} ${name}`, p))) return;
  const body: Record<string, unknown> = { confirm: true, by: 'cli' };
  if (p.bools.has('force')) body.force = true;
  const out = await api.req('POST', `/ops/services/${enc(name)}/${enc(action)}`, body);
  print(p, out, () => console.log('ok'));
}

// ---- qwen ----

export async function cmdQwen(api: Api, p: Parsed): Promise<void> {
  if (!p.rest.length) {
    const d = await api.get('/ops/qwen');
    return void print(p, d, () => {
      for (const [k, v] of Object.entries(d.env ?? {})) console.log(`${k}=${v}`);
      console.log(`health ${d.health ? 'ok' : 'down'}`);
    });
  }
  const verb = p.rest[0];
  const value = p.rest[1];
  if (!value) throw new Error('usage: alfred qwen <preset|slots|ctx|offload> <value> [--force]');
  if (!(await confirm(`change qwen ${verb} to ${value}`, p))) return;
  const body: Record<string, unknown> = { confirm: true, [verb]: value, by: 'cli' };
  if (p.bools.has('force')) body.force = true;
  const out = await api.req('POST', '/ops/qwen', body);
  print(p, out, () => console.log('ok'));
}

// ---- logs ----

export async function cmdLogs(api: Api, p: Parsed): Promise<void> {
  const name = p.rest[0];
  if (!name) throw new Error('usage: alfred logs <name> [-n N] [-f]');
  const n = flag(p, 'n') ?? '200';
  if (!/^\d+$/.test(n)) throw new Error('-n wants a number');
  const fetchLines = async (): Promise<string[]> => (await api.get(`/ops/logs/${enc(name)}?lines=${n}`)).lines ?? [];
  const seen = new Set<string>();
  for (const l of await fetchLines()) {
    console.log(l);
    seen.add(l);
  }
  if (!p.bools.has('f')) return;
  for (;;) {
    await sleep(2000);
    let lines: string[];
    try {
      lines = await fetchLines();
    } catch {
      continue; // server hiccup — keep tailing
    }
    for (const l of lines) {
      if (!seen.has(l)) {
        seen.add(l);
        console.log(l);
      }
    }
  }
}

// ---- config ----

export async function cmdConfig(api: Api, p: Parsed): Promise<void> {
  const sub = p.rest[0];
  if (sub === 'ls') {
    const list = await api.get('/ops/config');
    return void print(p, list, () => {
      for (const f of list) console.log(`${f.path} ${f.kind} ${f.size}`);
    });
  }
  if (sub === 'get') {
    const path = p.rest[1];
    if (!path) throw new Error('usage: alfred config get <path>');
    const d = await api.get(`/ops/config/file?path=${enc(path)}`);
    process.stdout.write(d.content.endsWith('\n') ? d.content : `${d.content}\n`);
    return;
  }
  if (sub === 'edit') {
    const path = p.rest[1];
    if (!path) throw new Error('usage: alfred config edit <path>');
    const d = await api.get(`/ops/config/file?path=${enc(path)}`);
    const editor = process.env.EDITOR || process.env.VISUAL;
    if (!editor) throw new Error('$EDITOR is not set (use `alfred config set <path> <localFile>`)');
    const dir = mkdtempSync(join(tmpdir(), 'alfred-edit-'));
    const file = join(dir, path.replace(/[\\/]/g, '_'));
    writeFileSync(file, d.content);
    const r = spawnSync(editor, [file], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`editor exited ${r.status ?? 'on a signal'}; nothing saved`);
    const next = readFileSync(file, 'utf8');
    unlinkSync(file);
    if (next === d.content) return void console.log('no changes');
    const out = await api.req('PUT', '/ops/config/file', { path, content: next, mtime: d.mtime, confirm: true, by: 'cli' });
    print(p, out, () => console.log(`saved ${path}`));
    return;
  }
  if (sub === 'set') {
    const [, path, localFile] = p.rest;
    if (!path || !localFile) throw new Error('usage: alfred config set <path> <localFile>');
    const content = readFileSync(localFile, 'utf8');
    const out = await api.req('PUT', '/ops/config/file', { path, content, confirm: true, by: 'cli' });
    print(p, out, () => console.log(`saved ${path}`));
    return;
  }
  throw new Error('usage: alfred config <ls|get|edit|set> [path] [localFile]');
}

// ---- build harness ----

export async function cmdBuilds(api: Api, p: Parsed): Promise<void> {
  const list = await api.get('/ops/dispatch');
  print(p, list, () => {
    for (const d of list) console.log(`${d.name} ${d.state} attempt ${d.attempt} ${d.branch}`);
  });
}

export async function cmdBuild(api: Api, p: Parsed): Promise<void> {
  const name = p.rest[0];
  if (!name) throw new Error('usage: alfred build <name>');
  const d = await api.get(`/ops/dispatch/${enc(name)}`);
  print(p, d, () => {
    const st = d.status;
    if (!st) return void console.log(`${name}: no status`);
    console.log(`${st.name} ${st.state} attempt ${st.attempt} ${st.branch}`);
    for (const l of (d.log ?? []).slice(-20)) console.log(`  ${l}`);
    if (d.check) console.log(`check: ${d.check}`);
  });
}

// ---- directory listings ----

export async function cmdNodes(api: Api, p: Parsed): Promise<void> {
  const list = await api.get('/nodes');
  print(p, list, () => {
    for (const n of list) {
      const roots = Object.entries(n.roots ?? {}).map(([k, v]) => `${k}=${v}`).join(' ');
      console.log(`${n.name} ${roots} caps=${(n.caps ?? []).join(',')} ${n.sandbox ? '(sandbox)' : ''}`);
    }
  });
}

export async function cmdModels(api: Api, p: Parsed): Promise<void> {
  const d = await api.get('/models');
  print(p, d, () => {
    for (const m of d.models ?? []) console.log(`${m.name} ${m.baseUrl ?? ''} ${m.model ?? ''} roles=${(m.roles ?? []).join(',')}`);
    for (const [role, m] of Object.entries(d.roles ?? {})) console.log(`role ${role} → ${m}`);
  });
}

export async function cmdPersonas(api: Api, p: Parsed): Promise<void> {
  const list = await api.get('/personas');
  print(p, list, () => {
    for (const x of list) {
      const tools = Array.isArray(x.tools) ? `${x.tools.length}` : String(x.tools ?? '');
      console.log(`${x.name} ${x.description ?? ''} tools=${tools} spawn=${x.canSpawn ? 'yes' : 'no'}`);
    }
  });
}

// ---- open ----

export async function cmdOpen(api: Api, p: Parsed): Promise<void> {
  const ref = p.rest[0];
  let url = `${api.url}/`;
  if (ref) {
    if (/^[A-Z]+-\d+$/.test(ref.toUpperCase())) url = `${api.url}/#/board/${ref.toUpperCase()}`;
    else {
      const d = await api.get(`/goals/${enc(ref)}`);
      url = `${api.url}/#/goal/${d.goal.id}`;
    }
  }
  if (p.bools.has('print')) return void console.log(url);
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(opener, [url], { stdio: 'ignore', detached: true });
  child.on('error', () => console.log(url)); // no opener available — at least show it
  child.unref();
}

// ---- jira ----

export async function cmdJira(api: Api, p: Parsed): Promise<void> {
  const sub = p.rest[0] ?? 'status';
  if (sub === 'sync') {
    const r = await api.req('POST', '/jira/sync');
    return print(p, r, () => {
      console.log(`jira sync: created ${r.created?.length ?? 0}, updated ${r.updated?.length ?? 0}, closed ${r.closed?.length ?? 0}, errors ${r.errors?.length ?? 0}`);
      for (const e of r.errors ?? []) console.log(`  error: ${e}`);
    });
  }
  if (sub !== 'status') throw new Error('usage: alfred jira status | sync');
  const s = await api.get('/jira/status');
  print(p, s, () => {
    if (!s.configured) return console.log(`jira: not configured — ${s.error ?? 'set JIRA_SITE, JIRA_EMAIL, JIRA_API_TOKEN in ~/.config/alfred.env'}`);
    console.log(`jira: ${s.site}${s.user ? ` as ${s.user}` : ''}${s.error ? ` (${s.error})` : ''}`);
    const pol = s.policy ?? {};
    console.log(`projects: ${(pol.projects ?? []).join(', ') || '(none — agents cannot create or comment)'}  types: ${(pol.issueTypes ?? []).join(', ')}`);
    const l = pol.limits ?? {}; const u = s.usage ?? {};
    console.log(`limits: creates ${u.createsToday ?? 0}/${l.createsPerDay ?? '-'} today · comments ${u.commentsToday ?? 0}/${l.commentsPerDay ?? '-'} · searches ${u.searchesHour ?? 0}/${l.searchesPerHour ?? '-'} this hour`);
    const imp = pol.import ?? {};
    console.log(`import: ${imp.enabled ? `every ${imp.everyMinutes} min (max ${imp.max})` : 'off'}  board=${imp.board || '(default)'}`);
    if (s.lastSync) console.log(`last sync: created ${s.lastSync.created?.length ?? 0}, updated ${s.lastSync.updated?.length ?? 0}, closed ${s.lastSync.closed?.length ?? 0}, errors ${s.lastSync.errors?.length ?? 0}`);
  });
}
