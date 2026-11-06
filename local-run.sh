#!/usr/bin/env bash
# Local trial of the build pipeline on one ticket of FACTORY_TARGET (default react_frontend). Needs TENSORX_API_KEY,
# FACTORY_DASHBOARD_TOKEN (the dashboard's value), and GL_TOKEN or FACTORY_GITHUB_TOKEN for the target's tracker and code host. FACTORY_DASHBOARD_URL defaults to https://localhost:3000, trusted through mkcert's root CA.
# Usage: ./local-run.sh <ticket iid> [step to start from]
# With a step, the run goes on from that step with the kept run/ dir (its record and clone) instead of starting over.
# A round (local-factory.sh sets FACTORY_BUILD_PIPELINE_ID and FACTORY_MR_IID): the event step restores that build run from <repo>.runs.
set -euo pipefail
iid=${1:?usage: ./local-run.sh <ticket iid> [step to start from]}
from=${2:-}
cd "$(dirname "$0")"
steps=(event triage prepare-patch code-review precommit-gate risk-check decision)
if [ -n "$from" ]; then
  case " ${steps[*]} " in *" $from "*) ;; *) echo "unknown step $from, use one of: ${steps[*]}"; exit 1 ;; esac
  [ -f run/record.json ] || { echo "no run/record.json to go on from"; exit 1; }
fi
target=${FACTORY_TARGET:-react_frontend}
[ -n "${GL_TOKEN:-}${FACTORY_GITHUB_TOKEN:-}" ] || { echo "set GL_TOKEN or FACTORY_GITHUB_TOKEN"; exit 1; }
: "${TENSORX_API_KEY:?TENSORX_API_KEY is not set}" "${FACTORY_DASHBOARD_TOKEN:?FACTORY_DASHBOARD_TOKEN is not set}"
secrets="$PWD.tmp" # the only dir the CI adapter reads secret files from
mkdir -p "$secrets"
# A copy-on-write clone of your pnpm store, so sandboxed installs reuse it instead of downloading every package.
store="$PWD.cache/pnpm-store"
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
  sandboxed="$HOME/Library/Caches/ms-playwright-sandbox"
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
# ponytail: the clock in seconds; two runs in one second would share it. The worker counts instead (nextId).
runs="$PWD.runs"
mkdir -p run
run_id=$(cat run/run-id 2>/dev/null || date +%s)
echo "$run_id" > run/run-id
# A resume skips the event step, so the ticket is moved back to running first.
[ -z "$from" ] || steps=(resume "${steps[@]}")
for step in "${steps[@]}"; do
  echo "== $step"
  # The step reads the files and deletes them. Only a token that is set gets a file and a variable.
  tokens=()
  [ -z "${GL_TOKEN:-}" ] || { printf %s "$GL_TOKEN" > "$secrets/gl"; tokens+=(FACTORY_GITLAB_TOKEN="$secrets/gl"); }
  [ -z "${FACTORY_GITHUB_TOKEN:-}" ] || { printf %s "$FACTORY_GITHUB_TOKEN" > "$secrets/gh"; tokens+=(FACTORY_GITHUB_TOKEN="$secrets/gh"); }
  [ -z "${TEAMS_WEBHOOK_URL:-}" ] || { printf %s "$TEAMS_WEBHOOK_URL" > "$secrets/teams"; tokens+=(TEAMS_WEBHOOK_URL="$secrets/teams"); }
  [ -z "${SLACK_WEBHOOK_URL:-}" ] || { printf %s "$SLACK_WEBHOOK_URL" > "$secrets/slack"; tokens+=(SLACK_WEBHOOK_URL="$secrets/slack"); }
  printf %s "$FACTORY_DASHBOARD_TOKEN" > "$secrets/dash"
  # env -i drops the shell's variables, so Claude Code authors need the Team plan token passed on by name.
  [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || tokens+=(CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN")
  # Its own Claude config, as the worker has: your ~/.claude hooks, plugins and CLAUDE.md must not reach the agents.
  env -i PATH="$PATH" HOME="$HOME" CLAUDE_CONFIG_DIR="$PWD/run/claude-home" PLAYWRIGHT_BROWSERS_PATH="$browsers" CI_SERVER_URL=https://gitlab.example.com \
    CI_PROJECT_ID=1 CI_PIPELINE_ID=1 FACTORY_RUN_ID="$run_id" FACTORY_PIPELINE=build FACTORY_TARGET="$target" \
    FACTORY_WORK_ITEM_IID="$iid" FACTORY_BUILD_PIPELINE_ID="${FACTORY_BUILD_PIPELINE_ID:-}" FACTORY_MR_IID="${FACTORY_MR_IID:-}" "${tokens[@]}" FACTORY_DASHBOARD_TOKEN="$secrets/dash" FACTORY_DASHBOARD_URL="${FACTORY_DASHBOARD_URL:-https://localhost:3000}" NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-$HOME/Library/Application Support/mkcert/rootCA.pem}" FACTORY_PNPM_STORE="$store" TENSORX_API_KEY="$TENSORX_API_KEY" CELERIS_API_KEY="${CELERIS_API_KEY:-}" \
    node --import tsx "$([ "$step" = resume ] && echo factory/local-resume.ts || echo "factory/steps/$step.ts")"
  # A round's event step restored the earlier run's run/ and its run-id: this run keeps its own number.
  [ "$step" != event ] || echo "$run_id" > run/run-id
done
# As the worker does: keep run/ without node_modules, with `ok` once decision ended well, for a later round or resume.
# ponytail: $runs only grows; delete old run dirs by hand when the disk fills.
mkdir -p "$runs/$run_id"
rsync -a --delete --exclude /target/node_modules run/ "$runs/$run_id/run/"
touch "$runs/$run_id/ok"
