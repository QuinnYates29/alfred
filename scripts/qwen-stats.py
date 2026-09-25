#!/usr/bin/env python3
"""Qwen performance ledger for the alfred build.

Reads DSH session logs (~/.dsh/sessions/<cwd>/session-*/session.jsonl.zstd) for every
dispatch worktree, plus the harness attempt ledger (docs/qwen/attempts.jsonl), and writes
docs/qwen/PERF.md. Safe to re-run any time; it rebuilds the report from scratch.

Per DSH session (= one attempt of one dispatched task) it reports:
  wall time, steps, tool calls (by tool), input/output tokens, peak prompt (context) tokens,
  output tok/s measured per step (output tokens / step wall time, so it includes queueing
  and prefill: the speed an agent actually experiences), and how much of the streamed text
  was reasoning vs visible output.
"""
import collections, datetime as dt, glob, json, os, re, subprocess, sys

HOME = os.path.expanduser('~')
REPO = os.path.join(HOME, 'repos/alfred')
OUT_DIR = os.path.join(REPO, 'docs/qwen')
SESSION_GLOB = os.path.join(HOME, '.dsh/sessions/--home-quinna-repos-*-wt-*--/session-*/session.jsonl.zstd')

# Server configuration epochs (local time). Append a line whenever qwen-server's launch config changes.
EPOCHS = [
    ('2026-09-24 14:38', 'np=6 ctx=98k (NVRM OOM, CPU fallback)'),
    ('2026-09-24 14:39', 'np=6 ctx=64k, no reasoning cap'),
    ('2026-09-24 15:14', 'np=6 ctx=64k, --reasoning-budget 1536, <=3 agents'),
]

def epoch_for(ts):
    label = EPOCHS[0][1]
    for start, name in EPOCHS:
        if ts >= dt.datetime.strptime(start, '%Y-%m-%d %H:%M'):
            label = name
    return label

def read_session(path):
    try:
        raw = subprocess.run(['zstdcat', path], capture_output=True, check=True).stdout.decode('utf8', 'replace')
    except subprocess.CalledProcessError:
        return None
    s = dict(path=path, steps=0, tools=collections.Counter(), inp=0, out=0, peak=0, reasoning=0, visible=0,
             step_rates=[], first=None, last=None, cwd='')
    step_start = {}
    for line in raw.splitlines():
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        t, ts = e.get('type'), e.get('time') or e.get('createdAt')
        if ts:
            s['first'] = ts if s['first'] is None else min(s['first'], ts)
            s['last'] = ts if s['last'] is None else max(s['last'], ts)
        d = e.get('data') or {}
        if t == 'session':
            s['cwd'] = e.get('cwd', '')
        elif t == 'step/start':
            step_start[(d.get('turn'), d.get('step'))] = ts
        elif t == 'tool/call':
            s['tools'][d.get('name', '?')] += 1
        elif t == 'assistant/chunk':
            blob = json.dumps(d)
            n = len(blob)
            if '"reasoning' in blob:
                s['reasoning'] += n
            else:
                s['visible'] += n
        elif t == 'assistant/message':
            u = d.get('usage') or {}
            i, o = u.get('inputTokens', 0) or 0, u.get('outputTokens', 0) or 0
            s['steps'] += 1
            s['inp'] += i
            s['out'] += o
            s['peak'] = max(s['peak'], i)
            st = step_start.get((d.get('turn'), d.get('step')))
            if st and ts and ts > st and o:
                s['step_rates'].append((o, (ts - st) / 1000))
    return s

def fmt_dur(sec):
    sec = int(sec)
    return f'{sec // 3600}h{(sec % 3600) // 60:02d}m' if sec >= 3600 else f'{sec // 60}m{sec % 60:02d}s'

def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    attempts = []
    ledger = os.path.join(OUT_DIR, 'attempts.jsonl')
    if os.path.exists(ledger):
        attempts = [json.loads(l) for l in open(ledger) if l.strip()]

    rows = []
    for p in sorted(glob.glob(SESSION_GLOB)):
        s = read_session(p)
        if not s or not s['first'] or s['steps'] == 0:
            continue
        task = re.search(r'-wt-([^-]+)--', p).group(1)
        start = dt.datetime.fromtimestamp(s['first'] / 1000)
        wall = (s['last'] - s['first']) / 1000
        out_tok = sum(o for o, _ in s['step_rates'])
        step_secs = sum(w for _, w in s['step_rates'])
        rate = out_tok / step_secs if step_secs else 0
        rs = s['reasoning'] / max(1, s['reasoning'] + s['visible'])
        rows.append(dict(task=task, start=start, wall=wall, epoch=epoch_for(start), steps=s['steps'],
                         tools=s['tools'], inp=s['inp'], out=s['out'], peak=s['peak'], rate=rate, reasoning_share=rs))
    rows.sort(key=lambda r: r['start'])

    L = ['# Qwen3.8-Flash-Next performance ledger (alfred build)', '',
         f'_Generated {dt.datetime.now():%Y-%m-%d %H:%M} by `scripts/qwen-stats.py`. Re-run anytime. Hand-written observations: [NOTES.md](NOTES.md)._', '',
         '## Per attempt (one DSH headless session each)', '',
         '| task | started | wall | server config | steps | tool calls | input tok | output tok | peak ctx | out tok/s* | reasoning share | top tools |',
         '|---|---|---|---|---|---|---|---|---|---|---|---|']
    for r in rows:
        top = ', '.join(f'{k}×{v}' for k, v in r['tools'].most_common(3))
        L.append(f"| {r['task']} | {r['start']:%m-%d %H:%M} | {fmt_dur(r['wall'])} | {r['epoch']} | {r['steps']} | {sum(r['tools'].values())} | "
                 f"{r['inp']:,} | {r['out']:,} | {r['peak']:,} | {r['rate']:.2f} | {r['reasoning_share']:.0%} | {top} |")
    L += ['', '\\* output tokens ÷ step wall time: what an agent actually experiences, including queueing behind other agents and prefill.', '']

    by = collections.defaultdict(list)
    for r in rows:
        by[r['epoch']].append(r)
    L += ['## By server configuration', '', '| config | sessions | median out tok/s | median peak ctx | total output tok | median reasoning share |', '|---|---|---|---|---|---|']
    med = lambda xs: sorted(xs)[len(xs) // 2] if xs else 0
    for ep, rs in by.items():
        L.append(f"| {ep} | {len(rs)} | {med([r['rate'] for r in rs]):.2f} | {med([r['peak'] for r in rs]):,} | {sum(r['out'] for r in rs):,} | {med([r['reasoning_share'] for r in rs]):.0%} |")

    if attempts:
        L += ['', '## Harness outcomes (acceptance-gated)', '', '| task | attempt | started | wall | dsh exit | check | result |', '|---|---|---|---|---|---|---|']
        for a in attempts:
            L.append(f"| {a['name']} | {a['attempt']} | {a['start'][5:16].replace('T', ' ')} | {fmt_dur(a['wall_s'])} | {a['dsh_exit']} | {a.get('tests', '')} | {'PASS' if a['check_rc'] == 0 else 'fail'} |")
        tasks = collections.defaultdict(list)
        for a in attempts:
            tasks[a['name']].append(a)
        passed = [n for n, xs in tasks.items() if any(x['check_rc'] == 0 for x in xs)]
        first = [n for n, xs in tasks.items() if xs and xs[0]['check_rc'] == 0 and xs[0]['attempt'] == 1]
        L += ['', f'Tasks passed: **{len(passed)}/{len(tasks)}**, first-attempt passes: **{len(first)}**.']

    open(os.path.join(OUT_DIR, 'PERF.md'), 'w').write('\n'.join(L) + '\n')
    print(f'wrote {OUT_DIR}/PERF.md ({len(rows)} sessions, {len(attempts)} ledger attempts)')

if __name__ == '__main__':
    main()
