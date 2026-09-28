#!/usr/bin/env bash
# Dispatch one implementation task to a local Qwen agent (DSH headless) in its own
# git worktree, looping until the acceptance command passes or attempts run out.
# Usage: qwen-task.sh NAME BRANCH PROMPT_FILE "CHECK_CMD" [ATTEMPTS=4] [TIMEOUT_MIN=60]
set -uo pipefail
# Run from a private copy: bash reads scripts incrementally, so editing/overwriting this file
# while a job runs would corrupt it (this killed P3a/P4a on 2026-09-24).
if [ -z "${QWEN_TASK_PRIVATE:-}" ]; then
  priv=$(mktemp "${TMPDIR:-/tmp}/qwen-task.XXXXXX.sh"); cp "$0" "$priv"
  QWEN_TASK_PRIVATE=1 exec bash "$priv" "$@"
fi
NAME=$1 BRANCH=$2 PROMPT_FILE=$3 CHECK=$4 ATTEMPTS=${5:-4} TMIN=${6:-60}
# Resolve the prompt before cd-ing into the worktree (a relative path silently became an empty prompt).
PROMPT_FILE=$(realpath "$PROMPT_FILE") || { echo "prompt file not found: $3" >&2; exit 2; }
[ -s "$PROMPT_FILE" ] || { echo "prompt file empty: $PROMPT_FILE" >&2; exit 2; }
REPO=${REPO:-$HOME/repos/alfred}
WT=${WT_ROOT:-$HOME/repos/alfred-wt}/$NAME
LOGS=$HOME/repos/alfred/.dispatch/$NAME; mkdir -p "$LOGS"
PROTECT=${PROTECT:-test/acceptance test/fixtures src/types.ts src/runtime/contract.ts src/runtime/testing.ts}
LINKS=${LINKS:-node_modules}
BASE=${BASE:-master}

if [ ! -d "$WT" ]; then
  git -C "$REPO" worktree add -q -b "$BRANCH" "$WT" "$BASE" || git -C "$REPO" worktree add -q "$WT" "$BRANCH"
  for l in $LINKS; do ln -sfn "$REPO/$l" "$WT/$l"; done
fi
cd "$WT"
FORK=$(git merge-base HEAD "$BASE")
status() { printf '{"name":"%s","branch":"%s","state":"%s","attempt":%s,"ts":"%s"}\n' "$NAME" "$BRANCH" "$1" "$2" "$(date -Is)" > "$LOGS/status.json"; }

feedback=""
a=1
while [ "$a" -le "$ATTEMPTS" ]; do
  status running "$a"
  prompt="$(cat "$HOME/repos/alfred/docs/dispatch/PREAMBLE.md" "$PROMPT_FILE")"
  if [ -n "$feedback" ]; then
    prompt="$prompt

## Attempt $a — the previous attempt did NOT pass the acceptance command
Command: $CHECK
Output tail:
\`\`\`
$feedback
\`\`\`
Fix the failures. Read the failing test and the code before changing anything."
  fi
  # Never spend an attempt while the model server is down (a restart used to burn all attempts in seconds).
  until curl -sf -m 5 http://127.0.0.1:1110/health >/dev/null; do echo "waiting for qwen-server $(date -Is)" >> "$LOGS/run.log"; sleep 30; done
  echo "=== attempt $a $(date -Is)" >> "$LOGS/run.log"
  t0=$(date +%s); start_iso=$(date -Is)
  timeout --kill-after=30 "${TMIN}m" dsh --profile headless "$prompt" >"$LOGS/attempt$a.out" 2>"$LOGS/attempt$a.err"
  dsh_rc=$?; echo "dsh exit=$dsh_rc $(date -Is)" >> "$LOGS/run.log"
  # A run that died within 2 minutes while the server was unhealthy is an outage, not an attempt: redo it.
  if [ $(( $(date +%s) - t0 )) -lt 120 ] && ! curl -sf -m 5 http://127.0.0.1:1110/health >/dev/null; then
    echo "server outage during attempt $a; not counting it" >> "$LOGS/run.log"; continue
  fi

  # Acceptance tests are the contract: restore them if the agent touched them.
  if ! git diff --quiet "$FORK" -- $PROTECT 2>/dev/null; then
    echo "agent modified protected files; restoring" >> "$LOGS/run.log"
    git checkout "$FORK" -- $PROTECT 2>/dev/null
  fi

  out=$(bash -c "$CHECK" 2>&1); rc=$?
  # vitest silently skips a named test file that doesn't exist — a check that names one must see it
  for tf in $(grep -oE 'test/[A-Za-z0-9_./-]+\.test\.(ts|mjs|js)' <<<"$CHECK"); do
    [ -f "$tf" ] || { rc=1; out="$out
MISSING TEST FILE: $tf (the acceptance command names it; write it)"; }
  done
  echo "$out" | tail -60 > "$LOGS/check$a.txt"
  echo "check rc=$rc" >> "$LOGS/run.log"
  tests=$(echo "$out" | grep -E "Tests |passed|failed" | tail -1 | sed 's/"/\\"/g' | tr -s ' ')
  printf '{"name":"%s","attempt":%s,"start":"%s","wall_s":%s,"dsh_exit":%s,"check_rc":%s,"tests":"%s","timeout_min":%s}\n' \
    "$NAME" "$a" "$start_iso" "$(( $(date +%s) - t0 ))" "$dsh_rc" "$rc" "$tests" "$TMIN" >> "$HOME/repos/alfred/docs/qwen/attempts.jsonl"
  if [ $rc -eq 0 ]; then
    git add -A && git commit -qm "$NAME: implemented by Qwen3.8-Flash-Next via DSH (attempt $a)" || true
    status passed "$a"; exit 0
  fi
  feedback=$(echo "$out" | grep -vE '^\s*$' | tail -80)
  # keep partial work so the next attempt builds on it rather than starting over
  git add -A && git commit -qm "$NAME: WIP attempt $a (check failing)" || true
  a=$((a+1))
done
status failed "$ATTEMPTS"; exit 1
