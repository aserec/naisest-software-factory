# Setup

People do the steps below. They need accounts and tokens. Tick each box when done.

The GitLab project is `Ceresa/software-factory`.

## 1. GitLab project

- [ ] Create the GitLab project `Ceresa/software-factory`.
- [ ] Create a bot user. Make a personal access token with the `api` scope.
- [ ] Make the bot Maintainer (or higher) of the factory project. Its trigger token must be allowed to set pipeline variables, and section 7 sets the minimum role for that to Maintainer.
- [ ] Store the token as a masked, protected CI variable `FACTORY_GITLAB_TOKEN` of type **File**.
- [ ] Signed in as the bot, create a pipeline trigger token. The finish pipeline only trusts build pipelines the bot started. Store it as a masked, protected CI variable `FACTORY_TRIGGER_TOKEN` of type **File**.
- [ ] Check the license under Admin > License.
  - Premium: give the bot merge rights by name on the protected branch of `react_frontend`.
  - Free: make the bot a Maintainer of `react_frontend`.

## 2. Other CI variables

Store each one as a masked, protected CI variable.

- [ ] `CLAUDE_CODE_OAUTH_TOKEN`: from Kirill's `claude setup-token`.
- [ ] `TENSORX_API_KEY`
- [ ] `TEAMS_WEBHOOK_URL` of type **File**: from a Teams Workflows flow "Post to a channel when a webhook request is received".
- [ ] `BERGET_API_KEY`: when it exists.

`FACTORY_GITLAB_TOKEN`, `FACTORY_TRIGGER_TOKEN`, `FACTORY_DASHBOARD_TOKEN` (section 10) and `TEAMS_WEBHOOK_URL` must be type File, not Variable. The step code reads each file and deletes it before any agent or target command runs. A step stops with an error if one of them is a plain Variable.

## 3. Runner files (done in the repo)

- `runner/config.toml.example`: runner config. Executor `docker-autoscaler`, plugin `hetznercloud/fleeting-plugin-hetzner`.
  - One job per VM: `capacity_per_instance = 1`, `max_use_count = 1`.
  - At most 4 VMs: `max_instances = 4`.
  - Location `fsn1` (Germany). Server type `ccx23` (4 vCPU, 16 GB). Image Ubuntu 24.04.
  - `privileged = false` and no Docker socket volume.
  - `security_opt` turns off the seccomp and AppArmor profiles of the job container, so bubblewrap can make user namespaces.
  - Runner tag: `factory`. Every job in `.gitlab-ci.yml` must use it.
- `runner/cloud-init.yml`: installs Docker and Grafana Alloy on each new VM and lets user namespaces keep their capabilities. Alloy ships the VM's logs and disk and memory to Grafana (section 10). Copy it to `/etc/gitlab-runner/cloud-init.yml` (the path in `user_data_file`).

- `runner/Dockerfile` also installs Chromium in `/ms-playwright`, for the before and after screenshots. Manual follow-up: after this merges to main, the `job-image` job prints the image digest. Put it in the `.factory` image of `.gitlab-ci.yml` and in `jobImage` of `targets/react_frontend.yml` in one reviewed change (`compose.ts` needs them equal). Until then CI has no Chromium, so every visual change in CI goes to a person.

### Hetzner Cloud firewall

Attach a firewall to the runner VMs (for example by label):

- No inbound rules. Nothing may connect to the VMs.
- Outbound: allow the internet (GitLab, npm, the Claude API).
- No routes to internal networks. Do not attach the VMs to a private network or VPN.

## 4. Register the runner

- [ ] Create a runner in the GitLab project with the tag `factory`. Copy its token.
- [ ] Install `gitlab-runner` and the fleeting plugin on a small host.
- [ ] Copy `runner/config.toml.example` to `/etc/gitlab-runner/config.toml` and `runner/cloud-init.yml` to `/etc/gitlab-runner/cloud-init.yml`. Fill in the runner token and the Hetzner API token.
- [ ] Fill in the Alloy values in `/etc/gitlab-runner/cloud-init.yml` (section 10, "Runner logs"). The file then holds a credential: make it readable by root only (`chmod 600`).
- [ ] Create the Hetzner firewall above and attach it.

## 5. Verify the runner

- [ ] Push this repo. Check that the `smoke` job runs on a fresh Hetzner VM.
- [ ] Expected: the job passes, and the Hetzner console shows the VM deleted after the job.

## 6. Agent files

- [ ] From the repo root, run `bash /path/to/agent-config/sync.sh`. It copies `.agents/`.
- [ ] Build the job image from `runner/Dockerfile` (see `docs/go-live.md`, section 3). It holds the pinned `claude` CLI and Pi in `/usr/local/bin`, which is on the fixed `PATH` of factory jobs, and `jq`, without which every agent job fails at `guardReady`.

## 7. Target webhook

For each target repo (Settings > Webhooks), add one webhook for issue, comment and merge request events (a comment with the line `@factory resume` resumes a stopped run). Its URL is:

```text
https://gitlab.example.com/api/v4/projects/<factory project id>/ref/main/trigger/pipeline?token=<trigger token>&variables[FACTORY_PIPELINE]=build&variables[FACTORY_TARGET]=<target name>&variables[SAST_DISABLED]=true&variables[SECRET_DETECTION_DISABLED]=true
```

- [ ] Use the same bot-owned trigger token that is stored in `FACTORY_TRIGGER_TOKEN`. The finish pipeline only trusts build pipelines started by the bot.
- [ ] `<target name>` must have a `targets/<target name>.yml` in this repo. Other names stop the job.
- [ ] In the factory project, set Settings > CI/CD > Variables > "Minimum role to use pipeline variables" to Maintainer.
- [ ] Keep webhook settings Maintainer-only in every target repo, and never give Maintainer to someone you would not trust with the factory.

Remaining risk. The webhook URL holds the trigger token. Anyone who can see the URL can start factory pipelines as the bot and set any CI variable. The factory limits what those variables can do:

- Every step starts through `env -i` with a fixed list of variables (see `.gitlab-ci.yml`). Variables such as `NODE_OPTIONS`, `npm_config_*` or `PATH` never reach node or pnpm.
- Step code accepts each `FACTORY_*` value only if it matches its pattern, and only targets with a `targets/<name>.yml`.
- The Berget and TensorX URLs and the Claude hook dir are fixed in code. No variable changes them.
- Step code accepts only `CI_SERVER_URL=https://gitlab.example.com` (fixed in code), so the GitLab token never goes to another host. `CI_PROJECT_ID` must be digits.
- Step code reads a File-type secret only from the runner's temp dir for this job (`<project dir>.tmp`), and deletes only files there. A variable that points anywhere else stops the step.

But the job shell itself still runs with every variable, before `env -i` starts. For example, `BASH_ENV` can run code in that shell, and that shell can read the File-type secrets. So a person who sees a webhook URL can reach the factory secrets. That is why webhook settings stay Maintainer-only.

## 8. Schedules

Two scheduled pipelines in the factory project (Build > Pipeline schedules). Create them signed in as the bot, so the bot owns them and the build pipelines they start are the bot's. Target branch: `main`.

- [ ] **Poller**, every minute (`* * * * *`). Variables: `FACTORY_SCHEDULE=poll`, `FACTORY_TARGET=<target name>`, `SAST_DISABLED=true`, `SECRET_DETECTION_DISABLED=true`. It is the fallback when the label webhook does not fire: it starts a build pipeline for each work item labeled `factory_ready`, oldest first, while the target has fewer than 2 active runs. The build's event step checks the live labels and who added `factory_ready`, as it does for a webhook.
- [ ] **Retry**, every hour (`0 * * * *`). Variables: `FACTORY_SCHEDULE=retry`, `FACTORY_TARGET=<target name>`, `SAST_DISABLED=true`, `SECRET_DETECTION_DISABLED=true`. It resumes runs labeled `factory_waiting` (Claude's usage limit). The new build pipeline loads the record of the pipeline that hit the limit, puts back its clone and Claude session, and continues at the step that stopped. If that record or session is not usable, the work item gets `factory_blocked` with a comment.

Make one pair of schedules for each target. `FACTORY_SCHEDULE` accepts only `poll` or `retry`. The `SAST_DISABLED` and `SECRET_DETECTION_DISABLED` variables keep the security scans from running every minute.

## 9. Contract tests against real tools

Every push runs the contract tests against fakes. A manual job, `contract-real`, runs them against the real tools. Start it from Build > Pipelines > Run pipeline (a web pipeline), then press play on the job.

- [ ] Make a GitLab test project that holds no real work, with a default branch and one pipeline that no trigger started (for example a trivial `.gitlab-ci.yml`). The tests create tickets, push branches and open changes in it. Close them by hand now and then.
- [ ] `CONTRACT_GITLAB_PROJECT`: the path of that test project, for example `Ceresa/factory-contract-test`. A plain CI variable.
- [ ] `CONTRACT_GITLAB_TOKEN`: a token of a bot user with the `api` scope and Developer role (or higher) on the test project only. Masked and protected, type **Variable**. Never reuse `FACTORY_GITLAB_TOKEN`.
- [ ] Test webhooks: none yet. If a later contract needs one, add it to the test project only, never to a target repo.

## 10. Dashboard

The dashboard (`dashboard/`) runs on its own Hetzner VM at `https://factory.<domain>`. `docs/how-it-works.md` says what it does. Replace `<domain>` with the real domain everywhere below.

### VM and DNS

- [ ] Create a small Hetzner VM with Ubuntu 24.04. Turn on Hetzner backups for it. The dashboard also writes a nightly backup of its database inside the VM (`/data/backups` in the `data` volume, 7 kept), but only Hetzner backups survive a lost VM.
- [ ] Hetzner firewall for this VM: inbound TCP 80 and 443 (Caddy gets the TLS certificate itself) and 22 (the deploy job connects from runner VMs, whose addresses change). Allow SSH keys only, no passwords.
- [ ] DNS: an A record `factory.<domain>` to the VM's address.
- [ ] Install Docker and Compose: `apt-get install -y docker.io docker-compose-v2`.
- [ ] Create a user `deploy` in the `docker` group: `adduser --disabled-password --comment "" deploy && usermod -aG docker deploy`.
- [ ] Create a deploy token on the factory project (Settings > Repository > Deploy tokens) with only `read_repository`. As `deploy`, clone the repo with it to `/opt/software-factory`:
  ```bash
  sudo install -d -o deploy -g deploy /opt/software-factory
  git clone https://<token user>:<token>@gitlab.example.com/Ceresa/software-factory.git /opt/software-factory
  ```

### GitLab OAuth app

- [ ] In GitLab, add an application (User settings > Applications, or the group's). Name: `Factory dashboard`. Redirect URI: `https://factory.<domain>/api/auth/callback/gitlab`. Confidential: yes. Scope: `read_user` only.
- [ ] Put its application ID and secret in `GITLAB_OAUTH_CLIENT_ID` and `GITLAB_OAUTH_CLIENT_SECRET` (below).

Sign-in only reads who the user is. The dashboard then reads the user's role on the factory project with its own read token, and lets in Developer and higher.

### Tokens

- [ ] `GITLAB_READ_TOKEN`: a personal access token of a read-only bot user, scope `read_api`. Make the bot Reporter on the factory project and on every target project.
- [ ] `GITLAB_CANCEL_TOKEN`: a project access token on the factory project only, role Developer, scope `api`. The dashboard uses it only to cancel a pipeline that did not stop. Two tokens, so a leaked read token cannot write.
- [ ] `GRAFANA_TOKEN`: in Grafana at `https://ops.<domain>`, a service account with the Viewer role, and a token for it.
- [ ] `LOKI_UID` and `METRICS_UID`: the UIDs of Grafana's Loki and metrics data sources (Connections > Data sources; the UID is the last part of the data source's URL).
- [ ] `FACTORY_DASHBOARD_TOKEN`: a random value, for example `openssl rand -hex 32`. Put the same value in the VM's `deploy/.env` and in the factory project as a masked, protected CI variable of type **File**. Factory steps send events with it and read it before any agent runs.
- [ ] `FACTORY_DISPATCH_TOKEN`: a random value, for example `openssl rand -hex 32`, in the VM's `deploy/.env`. Outside systems send dispatches with it (`POST /api/dispatches`, see docs/how-it-works.md). It can only add dispatches, so give it to cron jobs and monitors, never `FACTORY_DASHBOARD_TOKEN`. The dashboard starts the dispatch run itself, so `deploy/.env` also needs `FACTORY_TRIGGER_TOKEN` (the bot's trigger token from section 1). Dispatch runs need no schedule.
- [ ] `AUTH_SECRET`: a random value for the sign-in cookies, for example `openssl rand -base64 32`.
- [ ] In `seams.yml`, set `dashboardUrl` to `https://factory.<domain>` (it is `REPLACE_WITH_DASHBOARD_URL` until then, and every factory job stops with an error while it is).

### deploy/.env on the VM

Create `/opt/software-factory/deploy/.env`, owned by `deploy`, `chmod 600`. It is never in git. One `NAME=value` per line:

| Name | Value |
| --- | --- |
| `DASHBOARD_HOST` | `factory.<domain>` (Caddy serves and gets a certificate for this name) |
| `DASHBOARD_URL` | `https://factory.<domain>` |
| `AUTH_SECRET` | from above |
| `FACTORY_DASHBOARD_TOKEN` | from above, the same value as the CI variable |
| `FACTORY_DISPATCH_TOKEN` | from above |
| `FACTORY_TRIGGER_TOKEN` | the bot's pipeline trigger token, the same value as the CI variable. The dashboard starts dispatch runs with it |
| `FACTORY_PROJECT_ID` | the factory project's numeric ID |
| `GITLAB_URL` | `https://gitlab.example.com` |
| `GITLAB_READ_TOKEN` | from above |
| `GITLAB_CANCEL_TOKEN` | from above |
| `GITLAB_OAUTH_CLIENT_ID` | from the OAuth app |
| `GITLAB_OAUTH_CLIENT_SECRET` | from the OAuth app |
| `GRAFANA_URL` | `https://ops.<domain>` |
| `GRAFANA_TOKEN` | from above |
| `LOKI_UID` | from above |
| `METRICS_UID` | from above |

The image sets `TARGETS_DIR`, `DASHBOARD_DB` and `BACKUP_DIR` itself. Do not set them.

### Deploy job

The `deploy-dashboard` job in `.gitlab-ci.yml` runs on a push to `main` that changes `dashboard/`, `deploy/`, `targets/`, `factory/run-events.ts` or `pnpm-lock.yaml`. It connects over SSH as `deploy`, checks out the commit in `/opt/software-factory` and runs `docker compose -f deploy/compose.yml up -d --build`.

- [ ] Make an SSH key pair for the job: `ssh-keygen -t ed25519 -N "" -f dashboard-deploy`. Add `dashboard-deploy.pub` to `/home/deploy/.ssh/authorized_keys` on the VM.
- [ ] `DASHBOARD_DEPLOY_KEY`: the private key file `dashboard-deploy`. CI variable of type **File**, protected, environment scope `dashboard`.
- [ ] `DASHBOARD_KNOWN_HOSTS`: the VM's host key line. Run `ssh-keyscan factory.<domain>` and compare the key with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the VM. CI variable of type **File**, protected, environment scope `dashboard`.
- [ ] `DASHBOARD_HOST`: `factory.<domain>`. A protected CI variable with no environment scope, because the job's rule reads it and a rule may not see an environment-scoped variable. The deploy job runs only when it is set. It is not a secret.

Scope the two File variables to the `dashboard` environment (the deploy job's `environment`). A key that is only protected reaches every job on `main`, and SSH as `deploy` (in the `docker` group) is root on the dashboard VM.

### First deploy

- [ ] As `deploy` on the VM, in `/opt/software-factory`:
  ```bash
  docker compose -f deploy/compose.yml build
  docker compose -f deploy/compose.yml up -d
  curl -kI https://factory.<domain>/api/auth/signin
  ```
  Expected: the build and start succeed, and `curl` shows status 302 with `location: https://factory.<domain>/sign-in`.
- [ ] Open `https://factory.<domain>/sign-in` and sign in with GitLab as a Developer of the factory project.
- [ ] Every deploy leaves the old image behind. Run `docker image prune -f` on the VM now and then.

### Runner logs (Alloy)

`runner/cloud-init.yml` installs Grafana Alloy on each runner VM with the config in `deploy/alloy/runner.alloy`. Alloy sends the job container logs, the journal and the VM's disk and memory to `ops.<domain>`, labeled `job="factory-runner"`, `host` and (logs only) `source`. The dashboard's Runner page reads them back through Grafana.

- [ ] In the Grafana stack at `ops.<domain>`, create a push credential that can only write logs (Loki) and metrics.
- [ ] In the runner host's `/etc/gitlab-runner/cloud-init.yml` (never in git), replace:
  - `<LOKI_PUSH_URL>`: the Loki push URL, for example `https://ops.<domain>/loki/api/v1/push`.
  - `<METRICS_PUSH_URL>`: the metrics store's remote write URL.
  - `<ALLOY_PUSH_USER>` (twice) and `<ALLOY_PUSH_PASSWORD>`: the push credential.

Loki holds the raw output of job containers, and it is not masked: a secret that a job prints is in Loki as written. Give read access to that Loki tenant only to the people and tokens that need it.

The credential stays on the VM host in `/etc/alloy/`, readable by root only. The runner config mounts no host path into a job container, and cloud-init blocks job containers from the Hetzner metadata service, which serves the cloud-init file.

If Alloy fails to install or start on a VM, the VM still runs jobs, and its logs and disk and memory are missing in Grafana and on the Runner page. If the metadata block fails, cloud-init reports an error and the VM never takes a job.

The job VMs do not run `gitlab-runner`, so the `gitlab-runner` log source stays empty. To fill it, install Alloy on the runner host with the same config.

Checks (not run in the repo, because Alloy and the VMs are not there):

- [ ] `alloy fmt deploy/alloy/runner.alloy` exits 0.
- [ ] If apt on a VM cannot find `alloy=1.8.3`, take the exact version string from `apt-cache madison alloy` and pin that.
- [ ] Start one factory job. In Grafana Explore, `{job="factory-runner", source="docker"}` shows its lines, and the dashboard's Runner page shows the VM's disk and memory.
- [ ] Inside the job container, `ls /etc/alloy` fails, and `curl -m 5 http://169.254.169.254/hetzner/v1/userdata` gets no answer.
- [ ] A failed runcmd gives `cloud-init status` exit 1, not 2 (`instance_ready_command` in `config.toml` accepts 2). On a test VM, remove the line `iptables -I DOCKER-USER ...` from the cloud-init file, and check that `cloud-init status --wait` exits 1 and the VM never becomes ready. Put the line back after.

## Local use

```bash
pnpm install
pnpm vitest run
pnpm tsx factory/steps/<step>.ts
```

### Before and after screenshots

A target with `preview` and `previewUrl` in its `.factory.yml` gets screenshots of a visual change. Install Chromium once: `(cd react_frontend/apps/web && pnpm exec playwright install chromium)`. `local-run.sh` sets `PLAYWRIGHT_BROWSERS_PATH` to `~/Library/Caches/ms-playwright`.

The author takes each shot with one shell command (`prompts/prepare.md` holds it). It starts the preview in the background, waits up to 120 s for `previewUrl`, shoots, and stops the server:

```bash
root=$PWD; set -m; (<preview>) > run/preview.log 2>&1 & pid=$!
for i in $(seq 120); do curl -sf <previewUrl> > /dev/null && break; sleep 1; done
(cd apps/web && pnpm exec playwright screenshot --viewport-size "1280, 800" --wait-for-timeout 3000 <previewUrl> "$root/run/proof/after-x-1280.png"); kill -- -$pid
```

Not yet proven in the sandbox. The spike (this command under `srt` on macOS, under `srt` in the runner image on Linux, and under Claude Code's sandbox) is still to run. A good result is a PNG of the app, not the "Opening your workspace" screen. Results:

- [ ] macOS, Pi under `srt`: not run yet
- [ ] Linux, runner image under `srt`: not run yet
- [ ] Claude Code sandbox: not run yet
