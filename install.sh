#!/usr/bin/env bash
# Installs the factory on this machine with Docker: the dashboard behind Caddy (HTTPS), and what runs the tickets.
# That is the worker on this machine by default. With hetzner, GitLab CI runs them on one Hetzner VM per job instead.
# Usage: ./install.sh
# Needs Docker. The first run asks for the values in README.md (Install) and writes deploy/.env.
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
  echo "== deploy/.env does not exist yet. README.md (Install) lists every value and where to get it; have them ready."
  ask DASHBOARD_HOST "Dashboard host name" \
    "The name people open the dashboard at, with a DNS A record to this machine. localhost on your own computer." localhost
  ask GITLAB_URL "GitLab URL" "The address of your GitLab." https://gitlab.example.com
  ask FACTORY_PROJECT_ID "Factory project ID" \
    "GitLab, the factory project's page: the menu at the top right (three dots) > Copy project ID."
  ask GITLAB_OAUTH_CLIENT_ID "OAuth application ID" \
    "GitLab > User settings > Applications > Add new application. Name: Factory dashboard. Redirect URI: https://$DASHBOARD_HOST/api/auth/callback/gitlab. Confidential: yes. Scope: read_user only."
  ask GITLAB_OAUTH_CLIENT_SECRET "OAuth application secret" "The secret of the same application, shown once after you save it."
  ask GITLAB_READ_TOKEN "GitLab read token" \
    "Signed in as a read-only bot user (Reporter on the factory project and on every target project): User settings > Access tokens, scope read_api."
  ask GITLAB_CANCEL_TOKEN "GitLab cancel token" \
    "The factory project > Settings > Access tokens: role Developer, scope api. The dashboard only uses it to cancel a stuck pipeline."
  ask GRAFANA_URL "Grafana URL" "Optional: press Enter to skip. Without it the Runner page stays empty." "" optional
  GRAFANA_TOKEN="" LOKI_UID="" METRICS_UID=""
  if [ -n "$GRAFANA_URL" ]; then
    ask GRAFANA_TOKEN "Grafana token" "Grafana > Administration > Service accounts: add one with the Viewer role, then Add token."
    ask LOKI_UID "Loki data source UID" "Grafana > Connections > Data sources > your Loki source: the last part of its URL."
    ask METRICS_UID "Metrics data source UID" "The same, for your metrics (Prometheus or Mimir) source."
  fi
  while true; do
    ask COMPOSE_PROFILES "Where tickets run (worker or hetzner)" \
      "worker: on this machine. hetzner: GitLab CI runs each job on a new Hetzner VM, which needs the GitLab setup in docs/setup.md sections 1, 2, 7 and 8." worker
    case $COMPOSE_PROFILES in worker|hetzner) break ;; *) echo "  Type worker or hetzner." ;; esac
  done
  GL_TOKEN="" TENSORX_API_KEY=""
  if [ "$COMPOSE_PROFILES" = worker ]; then
    ask GL_TOKEN "Factory bot token" \
      "Signed in as the factory bot (it reads tickets and pushes and merges in the target repo, docs/setup.md section 1): User settings > Access tokens, scope api."
    ask TENSORX_API_KEY "TensorX API key" "Your TensorX account > API keys. The agents' models run there (router.yml)."
  else
    ask RUNNER_TOKEN "GitLab runner token" \
      "The factory project > Settings > CI/CD > Runners > New project runner, with the tag factory. Copy the token (glrt-...)."
    ask HETZNER_TOKEN "Hetzner Cloud API token" "Hetzner Cloud console > your project > Security > API tokens > Generate, with Read & Write."
  fi
  echo
  echo "== AUTH_SECRET and FACTORY_DASHBOARD_TOKEN are random values, made for you."
  umask 077
  cat > "$env_file" <<EOF
DASHBOARD_HOST=$DASHBOARD_HOST
DASHBOARD_URL=https://$DASHBOARD_HOST
AUTH_SECRET=$(openssl rand -base64 32)
FACTORY_DASHBOARD_TOKEN=$(openssl rand -hex 32)
FACTORY_PROJECT_ID=$FACTORY_PROJECT_ID
GITLAB_URL=$GITLAB_URL
GITLAB_READ_TOKEN=$GITLAB_READ_TOKEN
GITLAB_CANCEL_TOKEN=$GITLAB_CANCEL_TOKEN
GITLAB_OAUTH_CLIENT_ID=$GITLAB_OAUTH_CLIENT_ID
GITLAB_OAUTH_CLIENT_SECRET=$GITLAB_OAUTH_CLIENT_SECRET
GRAFANA_URL=$GRAFANA_URL
GRAFANA_TOKEN=$GRAFANA_TOKEN
LOKI_UID=$LOKI_UID
METRICS_UID=$METRICS_UID
COMPOSE_PROFILES=$COMPOSE_PROFILES
GL_TOKEN=$GL_TOKEN
TENSORX_API_KEY=$TENSORX_API_KEY
EOF
  echo "== wrote $env_file"
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
echo "GitLab CI sends its events with FACTORY_DASHBOARD_TOKEN from $env_file: put the same value in the CI variable (type File)."
echo "Logs: docker compose -f deploy/compose.yml logs -f"
