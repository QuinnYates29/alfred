#!/usr/bin/env bash
# Dispatch one implementation task to a local Qwen agent (DSH headless) in its own
# git worktree, looping until the acceptance command passes or attempts run out.
# Usage: qwen-task.sh NAME BRANCH PROMPT_FILE "CHECK_CMD" [ATTEMPTS=4] [TIMEOUT_MIN=60]
set -uo pipefail
NAME=$1 BRANCH=$2 PROMPT_FILE=$3 CHECK=$4 ATTEMPTS=${5:-4} TMIN=${6:-60}
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
for a in $(seq 1 "$ATTEMPTS"); do
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
  echo "=== attempt $a $(date -Is)" >> "$LOGS/run.log"
  t0=$(date +%s); start_iso=$(date -Is)
  timeout --kill-after=30 "${TMIN}m" dsh --profile headless "$prompt" >"$LOGS/attempt$a.out" 2>"$LOGS/attempt$a.err"
  dsh_rc=$?; echo "dsh exit=$dsh_rc $(date -Is)" >> "$LOGS/run.log"

  # Acceptance tests are the contract: restore them if the agent touched them.
  if ! git diff --quiet "$FORK" -- $PROTECT 2>/dev/null; then
    echo "agent modified protected files; restoring" >> "$LOGS/run.log"
    git checkout "$FORK" -- $PROTECT 2>/dev/null
  fi

  out=$(bash -c "$CHECK" 2>&1); rc=$?
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
done
status failed "$ATTEMPTS"; exit 1
