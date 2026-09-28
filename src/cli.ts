#!/usr/bin/env npx tsx
// P19 — the alfred CLI entry. Everything (except `serve`) talks to the HTTP API.
// Connection: ALFRED_URL/ALFRED_TOKEN env → ~/.config/alfred/cli.json → http://127.0.0.1:8790.
// `serve` is source-only: the bundle marks ./main.js external (see scripts/build-cli.mjs).
import { Api, Parsed, parseArgs, resolveConn } from './cli/util.js';
import { cmdGoal, cmdLogin, cmdShow, cmdStatus, cmdTail } from './cli/core.js';
import { cmdAdd, cmdBoard, cmdComment, cmdDone, cmdEdit, cmdInbox, cmdItem, cmdMv, cmdSend } from './cli/board.js';
import { cmdAsk, cmdChat } from './cli/chat.js';
import { cmdRun } from './cli/run.js';
import { cmdBuild, cmdBuilds, cmdConfig, cmdLogs, cmdModels, cmdNodes, cmdOpen, cmdPersonas, cmdQwen, cmdStats, cmdSvc } from './cli/ops.js';
import { cmdCat, cmdDiff, cmdDiscard, cmdFiles, cmdMerge, cmdTranscript } from './cli/review.js';

const USAGE = `alfred — the agent platform

  alfred serve                                   run the server (source only; env: ALFRED_DB, ALFRED_MIRROR_DIR,
                                                 ALFRED_WORK_ROOT, ALFRED_PORT, ALFRED_HOST, ALFRED_DECK_DIR,
                                                 ALFRED_DECK_PORT)
  alfred login --url <u> --token <t>             store credentials (~/.config/alfred/cli.json, 0600)

Goals & tasks
  alfred goal "<title>" [--spec S] [--check "n=cmd"]… [--repo P] [--persona P] [--file GOAL.md]
  alfred status                                list goals, newest first
  alfred show <goal>                           goal detail: tasks, usage, last events
  alfred stop <taskId> [reason]                stop a task
  alfred retry <taskId> [note]                 retry a failed/stopped task
  alfred approve <id> [--deny]                 decide an approval
  alfred tail                                  live event stream (one line per event)
  alfred inbox                                 everything that needs you

Board (P13)
  alfred board [--board K] [--status s] [--mine] list items by column
  alfred add "<title>" [--status s] [--prio p] [--label l]… [--assign a] [--due d] [--desc t] [--board K]
  alfred item <KEY>                            item detail (+ checklist, comments, goals)
  alfred mv <KEY> <status> · done <KEY>         move an item
  alfred comment <KEY> "<text>"                 comment on an item
  alfred edit <KEY> [--title t] [--prio p] [--assign a] [--due d] [--label l]… [--desc t]
  alfred send <KEY> [--persona p] [--repo r] [--node n] [--check name=cmd]…   dispatch as a goal

Chat (P16)
  alfred ask "<text>" [--thread id]             one-shot question to alfred
  alfred chat [--thread id]                     interactive ( /quit to leave )

Run (D1)
  alfred run [persona] "<prompt>" [--repo P] [--node N] [--wait]
                                                start an agent from one prompt (like "!coder fix x")

Ops (P14)
  alfred stats                                 GPU / Qwen / tokens / tasks / host
  alfred svc [restart|start|stop <name>] [--force]
  alfred qwen [preset|slots|ctx|offload <v>] [--force]
  alfred logs <name> [-n N] [-f]
  alfred config ls · get <path> · edit <path> · set <path> <localFile>
  alfred builds · build <name>
  alfred nodes · models · personas

Review (P15)
  alfred diff <goal> [--file p]                branches, files, diff of a goal's work
  alfred merge <goal> [--squash] [--into b] [--keep-branch]
  alfred discard <goal>
  alfred transcript <taskId>                   the story of a run
  alfred files <goal> [path] · cat <goal> <path>

  alfred open [goal|KEY] [--print]              open the web view

Global: --json (raw API JSON) · --yes (skip confirmations) · -h/--help
Server: ALFRED_URL, ALFRED_TOKEN (Bearer).`;

const need = (arg: string | undefined, use: string): string => {
  if (!arg) throw new Error(`usage: ${use}`);
  return arg;
};

async function runServe(): Promise<void> {
  const { startAlfred, serveConfig } = await import('./main.js');
  const a = await startAlfred(serveConfig());
  console.log(`alfred listening on ${a.url}`);
  // P12b: systemd sends SIGTERM on restart — stop Alfred (which requeues running tasks)
  // and exit 0. Re-entrant signals are ignored so stop() runs exactly once.
  let shuttingDown = false;
  const bye = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Never hang a restart: if a module or connection stalls, exit anyway after 10 s.
    setTimeout(() => process.exit(0), 10_000).unref();
    void a.stop().catch(() => {}).then(() => process.exit(0));
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

async function main(): Promise<void> {
  const [cmd, ...argv] = process.argv.slice(2);
  if (cmd === 'serve') return runServe();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }

  const conn = resolveConn();
  const api = new Api(conn.url, conn.token);
  const p: Parsed = parseArgs(argv);
  const one = (...a: string[]) => a.map((x) => x.trim()).filter(Boolean).join(' ') || undefined;

  switch (cmd) {
    case 'login': return cmdLogin(api, p);
    case 'goal': return cmdGoal(api, p);
    case 'status': return cmdStatus(api, p);
    case 'show': return cmdShow(api, p, need(argv[0], 'alfred show <goal id or slug>'));
    case 'stop': {
      const out = await api.req('POST', `/tasks/${encodeURIComponent(need(p.rest[0], 'alfred stop <taskId> [reason]'))}/stop`, {
        reason: one(...p.rest.slice(1)),
      });
      console.log(`stopped ${p.rest[0]}${out?.via === 'scheduler' ? ' (was running)' : ''}`);
      return;
    }
    case 'retry': {
      const t = await api.req('POST', `/tasks/${encodeURIComponent(need(p.rest[0], 'alfred retry <taskId> [note]'))}/retry`, {
        note: one(...p.rest.slice(1)),
      });
      console.log(`retried as task ${t.id}`);
      return;
    }
    case 'approve': {
      const id = need(p.rest[0], 'alfred approve <id> [--deny]');
      const out = await api.req('POST', `/approvals/${encodeURIComponent(id)}`, {
        decision: p.bools.has('deny') ? 'denied' : 'approved',
        by: 'cli',
      });
      console.log(`approval ${id}: ${p.bools.has('deny') ? 'denied' : 'approved'}`, out ?? '');
      return;
    }
    case 'tail': return cmdTail(api);
    case 'inbox': return cmdInbox(api, p);
    case 'board': return cmdBoard(api, p);
    case 'add': return cmdAdd(api, p);
    case 'item': return cmdItem(api, p, need(p.rest[0], 'alfred item <KEY>'));
    case 'mv': return cmdMv(api, p, need(p.rest[0], 'alfred mv <KEY> <status>'), need(p.rest[1], 'alfred mv <KEY> <status>'));
    case 'done': return cmdDone(api, p, need(p.rest[0], 'alfred done <KEY>'));
    case 'comment':
      return cmdComment(api, p, need(p.rest[0], 'alfred comment <KEY> "<text>"'),
        need(one(...p.rest.slice(1)), 'alfred comment <KEY> "<text>"'));
    case 'edit': return cmdEdit(api, p, need(p.rest[0], 'alfred edit <KEY> [flags]'));
    case 'send': return cmdSend(api, p, need(p.rest[0], 'alfred send <KEY> [--persona p]'));
    case 'ask': return cmdAsk(api, p);
    case 'chat': return cmdChat(api, p);
    case 'run': return cmdRun(api, p);
    case 'stats': return cmdStats(api, p);
    case 'svc': return cmdSvc(api, p);
    case 'qwen': return cmdQwen(api, p);
    case 'logs': return cmdLogs(api, p);
    case 'config': return cmdConfig(api, p);
    case 'builds': return cmdBuilds(api, p);
    case 'build': return cmdBuild(api, p);
    case 'nodes': return cmdNodes(api, p);
    case 'models': return cmdModels(api, p);
    case 'personas': return cmdPersonas(api, p);
    case 'diff': return cmdDiff(api, p, need(p.rest[0], 'alfred diff <goal> [--file p]'));
    case 'merge': return cmdMerge(api, p, need(p.rest[0], 'alfred merge <goal>'));
    case 'discard': return cmdDiscard(api, p, need(p.rest[0], 'alfred discard <goal>'));
    case 'transcript': return cmdTranscript(api, p, need(p.rest[0], 'alfred transcript <taskId>'));
    case 'files': return cmdFiles(api, p, need(p.rest[0], 'alfred files <goal> [path]'));
    case 'cat': return cmdCat(api, p, need(p.rest[0], 'alfred cat <goal> <path>'), need(p.rest[1], 'alfred cat <goal> <path>'));
    case 'open': return cmdOpen(api, p);
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.error(USAGE);
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(`alfred: ${e?.message ?? e}`);
  process.exit(1);
});
