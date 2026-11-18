#!/usr/bin/env bash
# Installs the factory on this machine with Docker: the dashboard behind Caddy (HTTPS), and what runs the tickets.
# That is the worker (factory/worker.ts), with each step in a new container: on this machine by default, or with hetzner
# on a new Hetzner VM per run. With gitlab, GitLab CI runs them on one Hetzner VM per job instead (seams.yml ci: gitlab).
# Usage: ./install.sh
# Needs Docker. The first run asks for the values in docs/install-with-ai.md (Values) and writes deploy/.env.
# Later runs keep deploy/.env and only rebuild and restart, so run it again after a git pull to update.
set -euo pipefail
cd "$(dirname "$0")"
env_file=deploy/.env

command -v docker >/dev/null || { echo "Docker is not installed. Install it, then run ./install.sh again:"; echo "  Linux: https://docs.docker.com/engine/install/   macOS and Windows: https://docs.docker.com/desktop/"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is missing: https://docs.docker.com/compose/install/"; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker does not answer. Start it, or on Linux add yourself to the docker group (sudo usermod -aG docker \$USER, then log in again)."; exit 1; }

# ask NAME "question" "where to get it" [default] [optional]: reads one value into NAME, again and again until it is not empty.
ask() {
  local value
  echo
  printf '  %s\n' "$3"
  while true; do
    read -rp "$2${4:+ [$4]}: " value
    value=${value:-${4:-}}
    if [ -n "$value" ] || [ -n "${5:-}" ]; then break; fi
    echo "  This one is required."
  done
  printf -v "$1" %s "$value"
}

if [ ! -f "$env_file" ]; then
  echo "== deploy/.env does not exist yet. docs/install-with-ai.md (Values) lists every value and where to get it; have them ready."
  ask DASHBOARD_HOST "Dashboard host name" \
    "The name people open the dashboard at, with a DNS A record to this machine. localhost on your own computer." localhost
  while true; do
    ask RUNS_ON "Where tickets run (machine, hetzner or gitlab)" \
      "machine: the worker runs each step in a new container on this machine. hetzner: the worker makes a new Hetzner VM for each run and deletes it after. gitlab: GitLab CI runs each job on a new Hetzner VM, which needs seams.yml ci: gitlab and the GitLab setup in docs/setup.md sections 1, 2, 7 and 8." machine
    case $RUNS_ON in machine|hetzner) COMPOSE_PROFILES=worker; break ;; gitlab) COMPOSE_PROFILES=hetzner; break ;; *) echo "  Type machine, hetzner or gitlab." ;; esac
  done
  # Which code hosts the targets use, from tracker and codeHost in targets/*.yml; a missing one means gitlab, as in the
  # dashboard. GitLab CI (gitlab above) needs GitLab too.
  found=""
  for f in targets/*.yml; do
    [ -f "$f" ] || continue
    for key in tracker codeHost; do found+=" $(sed -nE "s/^$key: *(git[a-z]*).*/\\1/p" "$f" | grep . || echo gitlab)"; done
  done
  case "$found" in *gitlab*github*|*github*gitlab*) guess=both ;; *github*) guess=github ;; *) guess=gitlab ;; esac
  while true; do
    ask HOSTS "Where your tickets and code live (gitlab, github or both)" \
      "Each target's tracker and codeHost in targets/. The guess comes from the target files there. You get only the questions for the hosts you name." "$guess"
    case $HOSTS in gitlab|github|both) break ;; *) echo "  Type gitlab, github or both." ;; esac
  done
  ON_GITLAB="" ON_GITHUB=""
  { [ "$HOSTS" != github ] || [ "$RUNS_ON" = gitlab ]; } && ON_GITLAB=1
  [ "$HOSTS" != gitlab ] && ON_GITHUB=1
  GITLAB_URL="" FACTORY_PROJECT_ID="" GITLAB_OAUTH_CLIENT_ID="" GITLAB_OAUTH_CLIENT_SECRET="" GITLAB_READ_TOKEN="" GITLAB_CANCEL_TOKEN=""
  if [ -n "$ON_GITLAB" ]; then
    ask GITLAB_URL "GitLab URL" "The address of your GitLab." https://gitlab.example.com
    ask FACTORY_PROJECT_ID "Factory project ID" \
      "GitLab, the factory project's page: the menu at the top right (three dots) > Copy project ID. GitLab sign-in checks membership of it."
    ask GITLAB_OAUTH_CLIENT_ID "GitLab OAuth application ID" \
      "For GitLab sign-in. GitLab > User settings > Applications > Add new application. Name: Factory dashboard. Redirect URI: https://$DASHBOARD_HOST/api/auth/callback/gitlab. Confidential: yes. Scope: read_user only."
    ask GITLAB_OAUTH_CLIENT_SECRET "GitLab OAuth application secret" "The secret of the same application, shown once after you save it."
    ask GITLAB_READ_TOKEN "GitLab read token" \
      "Signed in as a read-only bot user (Reporter on the factory project and on every target project): User settings > Access tokens, scope read_api."
    if [ "$RUNS_ON" = gitlab ]; then
      ask GITLAB_CANCEL_TOKEN "GitLab cancel token" \
        "The factory project > Settings > Access tokens: role Developer, scope api. The dashboard only uses it to cancel a stuck pipeline."
    fi
  fi
  GITHUB_READ_TOKEN="" GITHUB_OAUTH_CLIENT_ID="" GITHUB_OAUTH_CLIENT_SECRET=""
  if [ -n "$ON_GITHUB" ]; then
    ask GITHUB_READ_TOKEN "GitHub read token" \
      "For the board and GitHub sign-in. A fine-grained token that reads every GitHub target repo: Contents, Issues, Pull requests and Metadata read; for a board also Projects read."
    ask GITHUB_OAUTH_CLIENT_ID "GitHub OAuth app client ID" \
      "For GitHub sign-in. GitHub > Settings > Developer settings > OAuth Apps > New OAuth App. Callback URL: https://$DASHBOARD_HOST/api/auth/callback/github."
    ask GITHUB_OAUTH_CLIENT_SECRET "GitHub OAuth app client secret" "The same app > Generate a new client secret."
  fi
  ask GRAFANA_URL "Grafana URL" "Optional: press Enter to skip. Without it the Runner page stays empty." "" optional
  GRAFANA_TOKEN="" LOKI_UID="" METRICS_UID=""
  if [ -n "$GRAFANA_URL" ]; then
    ask GRAFANA_TOKEN "Grafana token" "Grafana > Administration > Service accounts: add one with the Viewer role, then Add token."
    ask LOKI_UID "Loki data source UID" "Grafana > Connections > Data sources > your Loki source: the last part of its URL."
    ask METRICS_UID "Metrics data source UID" "The same, for your metrics (Prometheus or Mimir) source."
  fi
  GL_TOKEN="" FACTORY_GITHUB_TOKEN="" TENSORX_API_KEY="" HETZNER_TOKEN="" CLAUDE_CODE_OAUTH_TOKEN="" CELERIS_API_KEY="" SLACK_WEBHOOK_URL="" TEAMS_WEBHOOK_URL=""
  if [ "$COMPOSE_PROFILES" = worker ]; then
    [ "$HOSTS" != github ] && ask GL_TOKEN "Factory bot token" \
      "For GitLab targets. Signed in as the factory bot (it reads tickets and pushes and merges in the target repo, docs/setup.md section 1): User settings > Access tokens, scope api."
    [ -n "$ON_GITHUB" ] && ask FACTORY_GITHUB_TOKEN "GitHub token" \
      "For GitHub targets (tracker github or github-project, codeHost github). A fine-grained token on the target repos: Contents, Issues and Pull requests read and write, Commit statuses and Checks read; for a board also Projects read and write."
    ask TENSORX_API_KEY "TensorX API key" "Your TensorX account > API keys. The writer and the chat models run there (router.yml, seams.yml)."
    ask CLAUDE_CODE_OAUTH_TOKEN "Claude Code token" \
      "Run claude setup-token, signed in to the Claude Team plan. The author, the reviewer and the fixer run on it (router.yml provider team-plan)."
    ask CELERIS_API_KEY "Celeris API key" \
      "The judge that answers triage, duplicate and risk questions (seams.yml judge: jev-celeris). Without it a step stops with an error."
    case "$(sed -n 's/^chat: *\([a-z]*\).*/\1/p' seams.yml)" in
      slack) ask SLACK_WEBHOOK_URL "Slack webhook URL" "A Slack app with Incoming Webhooks on, added to the channel for factory notices (seams.yml chat: slack)." ;;
      teams) ask TEAMS_WEBHOOK_URL "Teams webhook URL" "A Teams Workflows flow \"Post to a channel when a webhook request is received\" (seams.yml chat: teams)." ;;
    esac
    if [ "$RUNS_ON" = hetzner ]; then
      ask HETZNER_TOKEN "Hetzner Cloud API token" "Hetzner Cloud console > your project > Security > API tokens > Generate, with Read & Write."
      echo "  The VMs reach the dashboard at https://$DASHBOARD_HOST, so it needs a public name, not localhost."
    fi
  else
    ask RUNNER_TOKEN "GitLab runner token" \
      "The factory project > Settings > CI/CD > Runners > New project runner, with the tag factory. Copy the token (glrt-...)."
    ask HETZNER_TOKEN "Hetzner Cloud API token" "Hetzner Cloud console > your project > Security > API tokens > Generate, with Read & Write."
  fi
  echo
  echo "== AUTH_SECRET, FACTORY_DASHBOARD_TOKEN and FACTORY_DISPATCH_TOKEN are random values, made for you."
  umask 077
  cat > "$env_file" <<EOF
DASHBOARD_HOST=$DASHBOARD_HOST
DASHBOARD_URL=https://$DASHBOARD_HOST
AUTH_SECRET=$(openssl rand -base64 32)
FACTORY_DASHBOARD_TOKEN=$(openssl rand -hex 32)
FACTORY_DISPATCH_TOKEN=$(openssl rand -hex 32)
FACTORY_PROJECT_ID=$FACTORY_PROJECT_ID
GITLAB_URL=$GITLAB_URL
GITLAB_READ_TOKEN=$GITLAB_READ_TOKEN
GITLAB_CANCEL_TOKEN=$GITLAB_CANCEL_TOKEN
GITLAB_OAUTH_CLIENT_ID=$GITLAB_OAUTH_CLIENT_ID
GITLAB_OAUTH_CLIENT_SECRET=$GITLAB_OAUTH_CLIENT_SECRET
GITHUB_READ_TOKEN=$GITHUB_READ_TOKEN
GITHUB_OAUTH_CLIENT_ID=$GITHUB_OAUTH_CLIENT_ID
GITHUB_OAUTH_CLIENT_SECRET=$GITHUB_OAUTH_CLIENT_SECRET
GRAFANA_URL=$GRAFANA_URL
GRAFANA_TOKEN=$GRAFANA_TOKEN
LOKI_UID=$LOKI_UID
METRICS_UID=$METRICS_UID
COMPOSE_PROFILES=$COMPOSE_PROFILES
FACTORY_EXECUTOR=${RUNS_ON/gitlab/}
FACTORY_CI=$([ "$RUNS_ON" = gitlab ] && echo gitlab || echo local)
HETZNER_TOKEN=$HETZNER_TOKEN
$([ "$RUNS_ON" = hetzner ] && echo "FACTORY_DASHBOARD_URL=https://$DASHBOARD_HOST")
GL_TOKEN=$GL_TOKEN
FACTORY_GITHUB_TOKEN=$FACTORY_GITHUB_TOKEN
TENSORX_API_KEY=$TENSORX_API_KEY
CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN
CELERIS_API_KEY=$CELERIS_API_KEY
SLACK_WEBHOOK_URL=$SLACK_WEBHOOK_URL
TEAMS_WEBHOOK_URL=$TEAMS_WEBHOOK_URL
EOF
  echo "== wrote $env_file"
  # The VM setup (cloud-init) both Hetzner ways use. The gitlab way also gets the runner config.
  if [ -n "$HETZNER_TOKEN" ]; then
    mkdir -p deploy/runner
    cp runner/cloud-init.yml deploy/runner/cloud-init.yml
    echo "== wrote deploy/runner/cloud-init.yml. VM logs reach Grafana only after you fill its Alloy values."
  fi
  if [ "$COMPOSE_PROFILES" = hetzner ]; then
    mkdir -p deploy/runner
    config=$(<runner/config.toml.example)
    config=${config//<RUNNER_AUTH_TOKEN>/"$RUNNER_TOKEN"}
    config=${config//<HETZNER_API_TOKEN>/"$HETZNER_TOKEN"}
    config=${config//https:\/\/gitlab.example.com/"$GITLAB_URL"}
    printf '%s\n' "$config" > deploy/runner/config.toml
    cp runner/cloud-init.yml deploy/runner/cloud-init.yml
    echo "== wrote deploy/runner/. VM logs reach Grafana only after you fill the Alloy values in deploy/runner/cloud-init.yml."
  fi
fi

# Ubuntu 23.10+ stops unprivileged user namespaces, which the worker's bubblewrap sandbox needs (as on the CI runner VMs).
userns=/proc/sys/kernel/apparmor_restrict_unprivileged_userns
if grep -q '^COMPOSE_PROFILES=worker' "$env_file" && [ -f "$userns" ] && [ "$(cat "$userns")" != 0 ]; then
  echo "== allowing user namespaces for the worker sandbox"
  echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/60-factory-userns.conf >/dev/null
  sudo sysctl -q -p /etc/sysctl.d/60-factory-userns.conf
fi

echo "== building and starting (the first build takes several minutes)"
docker compose -f deploy/compose.yml up -d --build --remove-orphans
host=$(sed -n 's/^DASHBOARD_HOST=//p' "$env_file")
echo
echo "The dashboard runs at https://$host"
[ "$host" = localhost ] && echo "It uses Caddy's own certificate on localhost, so your browser warns once."
grep -q '^FACTORY_CI=gitlab' "$env_file" && echo "GitLab CI sends its events with FACTORY_DASHBOARD_TOKEN from $env_file: put the same value in the CI variable (type File)."
echo "Outside systems (cron audits, monitors) send dispatches with FACTORY_DISPATCH_TOKEN from $env_file (docs/how-it-works.md, Dispatches)."
grep -q '^FACTORY_CI=gitlab' "$env_file" && echo "To start dispatch runs, the dashboard needs FACTORY_TRIGGER_TOKEN in $env_file: the bot's pipeline trigger token (docs/setup.md)."
echo "Logs: docker compose -f deploy/compose.yml logs -f"
