#!/usr/bin/env bash
# The local factory: every minute it asks each target's tracker for ready tickets and runs each one with local-run.sh.
# Each target runs up to its maxRuns (targets/<name>.yml, default 2) tickets at once, each in its own slot dir slots/<target>-<n>,
# with its output in factory.log, every line prefixed with the slot. FACTORY_TARGET names the targets, space-separated (default react_frontend). Needs TENSORX_API_KEY,
# FACTORY_DASHBOARD_TOKEN (the dashboard's value, by default the one in dashboard/.env.local), and GL_TOKEN or FACTORY_GITHUB_TOKEN for the targets' tracker and code host. FACTORY_DASHBOARD_URL defaults to https://localhost:3000, trusted through mkcert's root CA.
# Usage: ./local-factory.sh start|stop|status   (run: the same loop in the foreground)
#        ./local-factory.sh fixer-start|fixer-stop|fixer-status   (the fix worker for plans approved in the dashboard chat;
#        a loop of its own, so start and stop of the factory never end a fix in progress)
# Do not use local-run.sh while the factory runs: both use run/ and the same secret file.
set -euo pipefail
cd "$(dirname "$0")"
# .env in the repo root (git-ignored, see .env.example): NAME=value lines, no quotes. A variable set in the shell wins.
while IFS='=' read -r k v || [ -n "$k" ]; do [[ $k =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] && [ -z "${!k+x}" ] && export "$k=$v"; done < <(cat .env 2>/dev/null); unset k v
state="$PWD/.cache"
pidfile="$state/factory.pid" log="$state/factory.log" slotdir="$PWD/slots"
fixpid="$state/fixer.pid" fixlog="$state/fixer.log"
secrets="$state/tmp" # the only dir the CI adapter reads secret files from
mkdir -p "$state" "$secrets"

# The pid must still be our loop: after a crash or reboot the pid in the file can belong to another process.
running() { [ -f "$pidfile" ] && ps -p "$(cat "$pidfile")" -o command= 2>/dev/null | grep -q "local-factory.sh run"; }
fixer_running() { [ -f "$fixpid" ] && ps -p "$(cat "$fixpid")" -o command= 2>/dev/null | grep -q "factory/fixer.ts"; }
# A step deletes the token files once it read them; a run that was killed may have left them behind.
drop_tokens() { local d; for d in "$secrets" "$secrets"/*/; do rm -f "$d/gl" "$d/gh" "$d/glbot" "$d/ghbot" "$d/dash" "$d/teams" "$d/slack"; done; }
# A slot is busy while the loop's subshell that runs its ticket lives.
busy() { [ -f "$1/pid" ] && ps -p "$(cat "$1/pid")" -o command= 2>/dev/null | grep -q "local-factory.sh run"; }
# The tickets that run now, one "<slot> <ticket>" per line.
in_progress() { local d; for d in "$slotdir"/*/; do d=${d%/}; busy "$d" && echo "$(basename "$d") $(cat "$d/ticket" 2>/dev/null)"; done; return 0; }
targets=${FACTORY_TARGET:-react_frontend}
need_tokens() {
  # Unset: the local dashboard's own value, which the default FACTORY_DASHBOARD_URL needs. Exported for the runs local-run.sh starts.
  [ -n "${FACTORY_DASHBOARD_TOKEN:-}" ] || export FACTORY_DASHBOARD_TOKEN=$(sed -n 's/^FACTORY_DASHBOARD_TOKEN=//p' dashboard/.env.local 2>/dev/null)
  [ -n "${GL_TOKEN:-}${FACTORY_GITHUB_TOKEN:-}" ] || { echo "set GL_TOKEN or FACTORY_GITHUB_TOKEN"; exit 1; }
  : "${TENSORX_API_KEY:?TENSORX_API_KEY is not set}" "${FACTORY_DASHBOARD_TOKEN:?FACTORY_DASHBOARD_TOKEN is not set}"
}

# The poll step's checks (trusted person, no active run, at most 2 active runs) for target $1, without starting a pipeline.
ready() { # $1 target, $2 its tickets that run now, comma-separated
  # The step reads the files and deletes them. Only a token that is set gets a file and a variable.
  local tokens=()
  [ -z "${GL_TOKEN:-}" ] || { printf %s "$GL_TOKEN" > "$secrets/gl"; tokens+=(FACTORY_GITLAB_TOKEN="$secrets/gl"); }
  [ -z "${FACTORY_GITHUB_TOKEN:-}" ] || { printf %s "$FACTORY_GITHUB_TOKEN" > "$secrets/gh"; tokens+=(FACTORY_GITHUB_TOKEN="$secrets/gh"); }
  [ -z "${FACTORY_BOT_GITHUB_TOKEN:-}" ] || { printf %s "$FACTORY_BOT_GITHUB_TOKEN" > "$secrets/ghbot"; tokens+=(FACTORY_BOT_GITHUB_TOKEN="$secrets/ghbot"); }
  [ -z "${FACTORY_BOT_GITLAB_TOKEN:-}" ] || { printf %s "$FACTORY_BOT_GITLAB_TOKEN" > "$secrets/glbot"; tokens+=(FACTORY_BOT_GITLAB_TOKEN="$secrets/glbot"); }
  [ -z "${TEAMS_WEBHOOK_URL:-}" ] || { printf %s "$TEAMS_WEBHOOK_URL" > "$secrets/teams"; tokens+=(TEAMS_WEBHOOK_URL="$secrets/teams"); }
  [ -z "${SLACK_WEBHOOK_URL:-}" ] || { printf %s "$SLACK_WEBHOOK_URL" > "$secrets/slack"; tokens+=(SLACK_WEBHOOK_URL="$secrets/slack"); }
  printf %s "$FACTORY_DASHBOARD_TOKEN" > "$secrets/dash"
  env -i PATH="$PATH" HOME="$HOME" CI_SERVER_URL=https://gitlab.example.com \
    CI_PROJECT_ID=1 CI_PIPELINE_ID=1 FACTORY_SCHEDULE=poll FACTORY_TARGET="$1" \
    "${tokens[@]}" FACTORY_DASHBOARD_TOKEN="$secrets/dash" FACTORY_DASHBOARD_URL="${FACTORY_DASHBOARD_URL:-https://localhost:3000}" NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-$HOME/Library/Application Support/mkcert/rootCA.pem}" TENSORX_API_KEY="$TENSORX_API_KEY" CELERIS_API_KEY="${CELERIS_API_KEY:-}" \
    node --import tsx factory/steps/poll.ts --list --finish --alive="$2"
}
max_runs() { local n; n=$(sed -n 's/^maxRuns: *\([0-9][0-9]*\).*/\1/p' "targets/$1.yml"); echo "${n:-2}"; } # 2: MAX_RUNS_PER_REPO
# The dir of a free slot of target $1, or fail when every slot is busy.
free_slot() { local n; for n in $(seq 1 "$(max_runs "$1")"); do busy "$slotdir/$1-$n" || { echo "$slotdir/$1-$n"; return 0; }; done; return 1; }
# Every slot dir, not only 1..maxRuns: a run in a slot above a lowered maxRuns is still alive.
alive() { local d; for d in "$slotdir/$1"-*/; do d=${d%/}; busy "$d" && cat "$d/ticket"; done | paste -sd, -; }
# The port {port} in the .factory.yml commands stands for in slot dir $2 of target $1: 3910, 10 more for each target
# before it in FACTORY_TARGET, plus the slot number less 1. So no two slots share a dev server port.
slot_port() { local i=0 t; for t in $targets; do [ "$t" = "$1" ] && break; i=$((i + 1)); done; echo $((3910 + i * 10 + ${2##*-} - 1)); }
# Runs entry $3 (ticket[:build run:change]) of target $1 in slot dir $2, in the background.
start_run() {
  local target=$1 dir=$2 iid build change slot port pipeline="" skip=""
  # A finish run prints as finish:ticket:build run:change:skip apply, such as the one after a person merged by hand.
  case $3 in
    finish:*) IFS=: read -r pipeline iid build change skip <<< "$3" ;;
    *) IFS=: read -r iid build change <<< "$3" ;;
  esac
  slot=$(basename "$dir") port=$(slot_port "$1" "$2")
  mkdir -p "$dir" && echo "$iid" > "$dir/ticket"
  (
    echo "$(date '+%F %T') == $target ticket $iid${pipeline:+ (finish run of change $change)}${build:+${pipeline:- (round on change $change)}} in slot $slot, port $port"
    # A failed step already marks the ticket blocked, so the poll does not pick it up again.
    FACTORY_WORK_DIR="$dir" FACTORY_PORT="$port" FACTORY_PIPELINE="$pipeline" FACTORY_SKIP_APPLY="$skip" FACTORY_TARGET="$target" FACTORY_BUILD_PIPELINE_ID="$build" FACTORY_MR_IID="$change" ./local-run.sh "$iid" 2>&1 \
      | while IFS= read -r line; do printf '[%s] %s\n' "$slot" "$line"; done \
      || echo "$(date '+%F %T') $target ticket $iid ended with an error"
    rm -f "$dir/pid" "$dir/ticket"
  ) &
  echo $! > "$dir/pid"
}

case "${1:-}" in
  start)
    need_tokens
    if running; then echo "The factory already runs, pid $(cat "$pidfile")"; exit 1; fi
    set -m # own process group, so stop also ends the run in progress
    nohup "$0" run >> "$log" 2>&1 &
    echo $! > "$pidfile"
    echo "The factory runs, pid $!. Log: $log"
    ;;
  stop)
    if ! running; then echo "The factory does not run"; rm -f "$pidfile"; drop_tokens; exit 0; fi
    stopped=$(in_progress) # before the kill: afterwards no slot looks busy
    kill -- "-$(cat "$pidfile")"
    rm -f "$pidfile"
    drop_tokens
    echo "The factory stopped"
    [ -z "$stopped" ] || while read -r slot ticket; do echo "Ticket $ticket was running in slot $slot. The next start runs it again."; done <<< "$stopped"
    rm -f "$slotdir"/*/pid "$slotdir"/*/ticket
    ;;
  status)
    if running; then echo "The factory runs, pid $(cat "$pidfile"). Log: $log"; else echo "The factory does not run"; fi
    in_progress | while read -r slot ticket; do echo "Ticket $ticket runs in slot $slot"; done
    ;;
  fixer-start)
    need_tokens
    if fixer_running; then echo "The fixer already runs, pid $(cat "$fixpid")"; exit 1; fi
    export FACTORY_DASHBOARD_URL="${FACTORY_DASHBOARD_URL:-https://localhost:3000}" NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-$HOME/Library/Application Support/mkcert/rootCA.pem}"
    set -m # own process group, so fixer-stop also ends the fix in progress
    nohup node --import tsx factory/fixer.ts >> "$fixlog" 2>&1 &
    echo $! > "$fixpid"
    echo "The fixer runs, pid $!. Log: $fixlog"
    ;;
  fixer-stop)
    if ! fixer_running; then echo "The fixer does not run"; rm -f "$fixpid"; exit 0; fi
    kill -- "-$(cat "$fixpid")"
    rm -f "$fixpid"
    echo "The fixer stopped. A plan it was running stays running."
    ;;
  fixer-status)
    if fixer_running; then echo "The fixer runs, pid $(cat "$fixpid"). Log: $fixlog"; else echo "The fixer does not run"; fi
    ;;
  run)
    need_tokens
    trap drop_tokens EXIT
    trap 'exit 143' TERM INT # bash skips the EXIT trap when an untrapped signal kills it
    # An entry the poll handed out while every slot of its target was busy, as "<target> <entry>": it starts once one is free.
    # The poll already posted for a round or a restart, so dropping it would lose that run.
    pending=()
    while true; do
      left=()
      for p in "${pending[@]}"; do
        read -r target entry <<< "$p"
        if dir=$(free_slot "$target"); then start_run "$target" "$dir" "$entry"; else left+=("$p"); fi
      done
      pending=("${left[@]}")
      for target in $targets; do
        # A target with a pending entry waits for its slot: a new poll would hand out more than it can run.
        case " ${pending[*]} " in *" $target "*) continue ;; esac
        if iids=$(ready "$target" "$(alive "$target")"); then
          for entry in $iids; do
            # A round prints as ticket:build run:change; a ready ticket as its number only.
            # The poll counts the active tickets, so it hands out no more ready tickets than free slots; a round may still find none.
            if dir=$(free_slot "$target"); then start_run "$target" "$dir" "$entry"; else pending+=("$target $entry"); fi
          done
        else
          echo "$(date '+%F %T') the $target poll failed, trying again in a minute"
        fi
      done
      sleep 60
    done
    ;;
  *) echo "usage: ./local-factory.sh start|stop|status|run|fixer-start|fixer-stop|fixer-status"; exit 1 ;;
esac
