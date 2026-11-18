#!/usr/bin/env bash
# Local trial of the build pipeline on one ticket of FACTORY_TARGET (default react_frontend). Needs
# FACTORY_DASHBOARD_TOKEN (the dashboard's value), and GL_TOKEN or FACTORY_GITHUB_TOKEN for the target's tracker and code host. FACTORY_DASHBOARD_URL defaults to https://localhost:3000, trusted through mkcert's root CA.
# Usage: ./local-run.sh <ticket iid> [step to start from]
# With a step, the run goes on from that step with the kept run/ dir (its record and clone) instead of starting over.
# A round (local-factory.sh sets FACTORY_BUILD_PIPELINE_ID and FACTORY_MR_IID): the event step restores that build run from <repo>.runs.
# FACTORY_WORK_DIR: the folder that holds this run's run/ (default: the repo). local-factory.sh gives each parallel run its
# own, with its own secret files and browsers dir. To go on from a step there, pass the same FACTORY_WORK_DIR.
# FACTORY_PORT: the port {port} in the .factory.yml commands stands for (default 3910), one per parallel run.
set -euo pipefail
iid=${1:?usage: ./local-run.sh <ticket iid> [step to start from]}
from=${2:-}
cd "$(dirname "$0")"
# .env in the repo root (git-ignored, see .env.example): NAME=value lines, no quotes. A variable set in the shell wins.
while IFS='=' read -r k v || [ -n "$k" ]; do [[ $k =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] && [ -z "${!k+x}" ] && export "$k=$v"; done < <(cat .env 2>/dev/null); unset k v
root=$PWD
work=${FACTORY_WORK_DIR:-$root}
slot=${FACTORY_WORK_DIR:+-$(basename "$FACTORY_WORK_DIR")}
mkdir -p "$work" && cd "$work"
# FACTORY_PIPELINE=finish (set by this script itself): the finish run of build run FACTORY_BUILD_PIPELINE_ID, which merges change FACTORY_MR_IID.
pipeline=${FACTORY_PIPELINE:-build}
steps=(event triage prepare-patch code-review precommit-gate risk-check decision)
[ "$pipeline" = build ] || steps=(apply verify result-saved)
if [ -n "$from" ]; then
  case " ${steps[*]} " in *" $from "*) ;; *) echo "unknown step $from, use one of: ${steps[*]}"; exit 1 ;; esac
  [ -f run/record.json ] || { echo "no run/record.json to go on from"; exit 1; }
fi
target=${FACTORY_TARGET:-react_frontend}
[ -n "${GL_TOKEN:-}${FACTORY_GITHUB_TOKEN:-}" ] || { echo "set GL_TOKEN or FACTORY_GITHUB_TOKEN"; exit 1; }
: "${FACTORY_DASHBOARD_TOKEN:?FACTORY_DASHBOARD_TOKEN is not set}"
secrets="$root/.cache/tmp${slot:+/${slot#-}}" # under the only dir the CI adapter reads secret files from
mkdir -p "$secrets"
# A copy-on-write clone of your pnpm store, so sandboxed installs reuse it instead of downloading every package.
store="$root/.cache/pnpm-store"
if [ ! -d "$store/v11" ] && [ -d "$HOME/Library/pnpm/store/v11" ]; then # macOS only; elsewhere pnpm fills it
  echo "== copying the pnpm store (first run only)"
  mkdir -p "$store" && cp -cR "$HOME/Library/pnpm/store/v11" "$store/"
fi
mkdir -p "$store"
# Chromium for the screenshots and e2e tests, installed once with: (cd <target> && npx playwright install chromium)
browsers=${PLAYWRIGHT_BROWSERS_PATH:-$HOME/Library/Caches/ms-playwright}
if [ "$(uname)" = Darwin ] && [ -d "$browsers" ]; then
  # The macOS sandbox denies mach-register, so Chromium's child-process port server kills it at start
  # (bootstrap_check_in ... Permission denied). One process needs no such server. This copy of the browsers dir
  # links every file but swaps each headless shell for a script that adds --single-process, so the target's own
  # playwright screenshot and playwright test work unchanged. Headed Chromium is not swapped: the agent runs headless.
  sandboxed="$HOME/Library/Caches/ms-playwright-sandbox$slot"
  rm -rf "$sandboxed" && mkdir -p "$sandboxed"
  for entry in "$browsers"/*; do
    case "$(basename "$entry")" in
      chromium_headless_shell-*)
        for sub in "$entry"/*; do
          dest="$sandboxed/$(basename "$entry")/$(basename "$sub")"
          if [ -d "$sub" ]; then
            mkdir -p "$dest" && ln -s "$sub"/* "$dest/"
            rm "$dest/chrome-headless-shell" && printf '#!/bin/sh\nexec "%s" --single-process "$@"\n' "$sub/chrome-headless-shell" > "$dest/chrome-headless-shell" && chmod +x "$dest/chrome-headless-shell"
          else
            ln -s "$sub" "$dest"
          fi
        done ;;
      *) ln -s "$entry" "$sandboxed/" ;;
    esac
  done
  browsers=$sandboxed
fi
if [ -n "$from" ]; then
  rm -f run/stop # a stop skips every later step
  while [ "${steps[0]}" != "$from" ]; do steps=("${steps[@]:1}"); done
else
  rm -rf ./run # each trial starts with a new run record
fi
# Each run has its own number, the build run its change names, so a later round can restore it from $runs.
# The clock in seconds, one up while another run took that number: mkdir reserves it, so parallel runs never share one.
runs="$root/.cache/runs"
mkdir -p run "$runs"
if [ -f run/run-id ]; then
  run_id=$(cat run/run-id)
else
  run_id=$(date +%s)
  while ! mkdir "$runs/$run_id" 2>/dev/null; do run_id=$((run_id + 1)); done
  trap 'rmdir "$runs/$run_id" 2>/dev/null || true' EXIT # a run that ended early keeps no empty reservation
fi
echo "$run_id" > run/run-id
tsx=$(cd "$root" && node -p 'require("url").pathToFileURL(require.resolve("tsx")).href') # cwd is $work: a bare tsx is not found there
# A resume skips the event step, so the ticket is moved back to running first.
[ -z "$from" ] || steps=(resume "${steps[@]}")
for step in "${steps[@]}"; do
  echo "== $step"
  # The step reads the files and deletes them. Only a token that is set gets a file and a variable.
  tokens=()
  [ -z "${GL_TOKEN:-}" ] || { printf %s "$GL_TOKEN" > "$secrets/gl"; tokens+=(FACTORY_GITLAB_TOKEN="$secrets/gl"); }
  [ -z "${FACTORY_GITHUB_TOKEN:-}" ] || { printf %s "$FACTORY_GITHUB_TOKEN" > "$secrets/gh"; tokens+=(FACTORY_GITHUB_TOKEN="$secrets/gh"); }
  [ -z "${FACTORY_BOT_GITHUB_TOKEN:-}" ] || { printf %s "$FACTORY_BOT_GITHUB_TOKEN" > "$secrets/ghbot"; tokens+=(FACTORY_BOT_GITHUB_TOKEN="$secrets/ghbot"); }
  [ -z "${FACTORY_BOT_GITLAB_TOKEN:-}" ] || { printf %s "$FACTORY_BOT_GITLAB_TOKEN" > "$secrets/glbot"; tokens+=(FACTORY_BOT_GITLAB_TOKEN="$secrets/glbot"); }
  [ -z "${TEAMS_WEBHOOK_URL:-}" ] || { printf %s "$TEAMS_WEBHOOK_URL" > "$secrets/teams"; tokens+=(TEAMS_WEBHOOK_URL="$secrets/teams"); }
  [ -z "${SLACK_WEBHOOK_URL:-}" ] || { printf %s "$SLACK_WEBHOOK_URL" > "$secrets/slack"; tokens+=(SLACK_WEBHOOK_URL="$secrets/slack"); }
  printf %s "$FACTORY_DASHBOARD_TOKEN" > "$secrets/dash"
  # env -i drops the shell's variables, so Claude Code authors need the Team plan token passed on by name.
  [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || tokens+=(CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN")
  # Its own Claude config, as the worker has: your ~/.claude hooks, plugins and CLAUDE.md must not reach the agents.
  env -i PATH="$PATH" HOME="$HOME" CLAUDE_CONFIG_DIR="$PWD/run/claude-home" PLAYWRIGHT_BROWSERS_PATH="$browsers" CI_SERVER_URL=https://gitlab.example.com \
    CI_PROJECT_ID=1 CI_PIPELINE_ID=1 FACTORY_RUN_ID="$run_id" FACTORY_PIPELINE="$pipeline" FACTORY_LOCAL_FINISH=1 FACTORY_TARGET="$target" \
    FACTORY_WORK_ITEM_IID="$iid" FACTORY_ID="${FACTORY_ID:-}" FACTORY_PORT="${FACTORY_PORT:-}" FACTORY_BUILD_PIPELINE_ID="${FACTORY_BUILD_PIPELINE_ID:-}" FACTORY_MR_IID="${FACTORY_MR_IID:-}" FACTORY_SKIP_APPLY="${FACTORY_SKIP_APPLY:-}" FACTORY_GIT_EMAIL="${FACTORY_GIT_EMAIL:-}" "${tokens[@]}" FACTORY_DASHBOARD_TOKEN="$secrets/dash" FACTORY_DASHBOARD_URL="${FACTORY_DASHBOARD_URL:-https://localhost:3000}" NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-$HOME/Library/Application Support/mkcert/rootCA.pem}" FACTORY_PNPM_STORE="$store" TENSORX_API_KEY="${TENSORX_API_KEY:-}" CELERIS_API_KEY="${CELERIS_API_KEY:-}" \
    node --import "$tsx" "$root/$([ "$step" = resume ] && echo factory/local-resume.ts || echo "factory/steps/$step.ts")"
  # A round's event step restored the earlier run's run/ and its run-id: this run keeps its own number.
  [ "$step" != event ] || echo "$run_id" > run/run-id
done
# As the worker does: keep run/ without node_modules or .venv (its scripts name this slot's path; install rebuilds it), with `ok` once decision ended well, for a later round or resume.
# ponytail: $runs only grows; delete old run dirs by hand when the disk fills.
mkdir -p "$runs/$run_id"
rsync -a --delete --exclude /target/node_modules --exclude /target/.venv run/ "$runs/$run_id/run/"
[ "$pipeline" = build ] || exit 0 # only a build run vouches with `ok`, as in the worker
touch "$runs/$run_id/ok"
# The decision step queued a finish run for this build when it decided to merge. The worker would take it from the queue;
# here this script runs it, in a new run/ and with a run number of its own. Older queue files belong to no live run and stay.
queued=$(grep -l "\"buildRun\":\"$run_id\"" "$root/.cache/queue"/*.json 2>/dev/null | xargs grep -l '"kind":"finish"' 2>/dev/null | head -1 || true)
if [ -n "$queued" ]; then
  change=$(sed -n 's/.*"change":"\([0-9]*\)".*/\1/p' "$queued")
  rm -f "$queued"
  trap - EXIT # this run is saved: keep its reservation
  echo "== finish run of change $change"
  FACTORY_PIPELINE=finish FACTORY_BUILD_PIPELINE_ID="$run_id" FACTORY_MR_IID="$change" "$root/local-run.sh" "$iid"
fi
