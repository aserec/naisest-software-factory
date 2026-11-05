#!/usr/bin/env bash
# The local factory: every minute it asks each target's tracker for ready tickets and runs each one with local-run.sh,
# one at a time. FACTORY_TARGET names the targets, space-separated (default react_frontend). Needs TENSORX_API_KEY,
# FACTORY_DASHBOARD_TOKEN (the dashboard's value), and GL_TOKEN or FACTORY_GITHUB_TOKEN for the targets' tracker and code host. FACTORY_DASHBOARD_URL defaults to https://localhost:3000, trusted through mkcert's root CA.
# Usage: ./local-factory.sh start|stop|status   (run: the same loop in the foreground)
# Do not use local-run.sh while the factory runs: both use run/ and the same secret file.
set -euo pipefail
cd "$(dirname "$0")"
state="$PWD.cache"
pidfile="$state/factory.pid" log="$state/factory.log" current="$state/factory.ticket"
secrets="$PWD.tmp" # the only dir the CI adapter reads secret files from
mkdir -p "$state" "$secrets"

# The pid must still be our loop: after a crash or reboot the pid in the file can belong to another process.
running() { [ -f "$pidfile" ] && ps -p "$(cat "$pidfile")" -o command= 2>/dev/null | grep -q "local-factory.sh run"; }
# A step deletes the token files once it read them; a run that was killed may have left them behind.
drop_tokens() { rm -f "$secrets/gl" "$secrets/gh" "$secrets/dash"; }
targets=${FACTORY_TARGET:-react_frontend}
need_tokens() {
  [ -n "${GL_TOKEN:-}${FACTORY_GITHUB_TOKEN:-}" ] || { echo "set GL_TOKEN or FACTORY_GITHUB_TOKEN"; exit 1; }
  : "${TENSORX_API_KEY:?TENSORX_API_KEY is not set}" "${FACTORY_DASHBOARD_TOKEN:?FACTORY_DASHBOARD_TOKEN is not set}"
}

# The poll step's checks (trusted person, no active run, at most 2 active runs) for target $1, without starting a pipeline.
ready() {
  # The step reads the files and deletes them. Only a token that is set gets a file and a variable.
  local tokens=()
  [ -z "${GL_TOKEN:-}" ] || { printf %s "$GL_TOKEN" > "$secrets/gl"; tokens+=(FACTORY_GITLAB_TOKEN="$secrets/gl"); }
  [ -z "${FACTORY_GITHUB_TOKEN:-}" ] || { printf %s "$FACTORY_GITHUB_TOKEN" > "$secrets/gh"; tokens+=(FACTORY_GITHUB_TOKEN="$secrets/gh"); }
  printf %s "$FACTORY_DASHBOARD_TOKEN" > "$secrets/dash"
  env -i PATH="$PATH" HOME="$HOME" CI_SERVER_URL=https://gitlab.example.com \
    CI_PROJECT_ID=1 CI_PIPELINE_ID=1 FACTORY_SCHEDULE=poll FACTORY_TARGET="$1" \
    "${tokens[@]}" FACTORY_DASHBOARD_TOKEN="$secrets/dash" FACTORY_DASHBOARD_URL="${FACTORY_DASHBOARD_URL:-https://localhost:3000}" NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-$HOME/Library/Application Support/mkcert/rootCA.pem}" TENSORX_API_KEY="$TENSORX_API_KEY" \
    node --import tsx factory/steps/poll.ts --list
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
    kill -- "-$(cat "$pidfile")"
    rm -f "$pidfile"
    drop_tokens
    echo "The factory stopped"
    if [ -f "$current" ]; then
      echo "Ticket $(cat "$current") was running. It stays running: set it to ready again to run it again."
      rm -f "$current"
    fi
    ;;
  status)
    if running; then echo "The factory runs, pid $(cat "$pidfile"). Log: $log"; else echo "The factory does not run"; fi
    ;;
  run)
    need_tokens
    trap drop_tokens EXIT
    trap 'exit 143' TERM INT # bash skips the EXIT trap when an untrapped signal kills it
    while true; do
      for target in $targets; do
        if iids=$(ready "$target"); then
          for iid in $iids; do
            echo "$(date '+%F %T') == $target ticket $iid"
            echo "$target $iid" > "$current"
            # A failed step already marks the ticket blocked, so the poll does not pick it up again.
            FACTORY_TARGET="$target" ./local-run.sh "$iid" || echo "$(date '+%F %T') $target ticket $iid ended with an error"
            rm -f "$current"
          done
        else
          echo "$(date '+%F %T') the $target poll failed, trying again in a minute"
        fi
      done
      sleep 60
    done
    ;;
  *) echo "usage: ./local-factory.sh start|stop|status|run"; exit 1 ;;
esac
