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

`FACTORY_GITLAB_TOKEN`, `FACTORY_TRIGGER_TOKEN` and `TEAMS_WEBHOOK_URL` must be type File, not Variable. The step code reads each file and deletes it before any agent or target command runs. A step stops with an error if one of them is a plain Variable.

## 3. Runner files (done in the repo)

- `runner/config.toml.example`: runner config. Executor `docker-autoscaler`, plugin `hetznercloud/fleeting-plugin-hetzner`.
  - One job per VM: `capacity_per_instance = 1`, `max_use_count = 1`.
  - At most 4 VMs: `max_instances = 4`.
  - Location `fsn1` (Germany). Server type `ccx23` (4 vCPU, 16 GB). Image Ubuntu 24.04.
  - `privileged = false` and no Docker socket volume.
  - `security_opt` turns off the seccomp and AppArmor profiles of the job container, so bubblewrap can make user namespaces.
  - Runner tag: `factory`. Every job in `.gitlab-ci.yml` must use it.
- `runner/cloud-init.yml`: installs Docker on each new VM and lets user namespaces keep their capabilities. Copy it to `/etc/gitlab-runner/cloud-init.yml` (the path in `user_data_file`).

### Hetzner Cloud firewall

Attach a firewall to the runner VMs (for example by label):

- No inbound rules. Nothing may connect to the VMs.
- Outbound: allow the internet (GitLab, npm, the Claude API).
- No routes to internal networks. Do not attach the VMs to a private network or VPN.

## 4. Register the runner

- [ ] Create a runner in the GitLab project with the tag `factory`. Copy its token.
- [ ] Install `gitlab-runner` and the fleeting plugin on a small host.
- [ ] Copy `runner/config.toml.example` to `/etc/gitlab-runner/config.toml` and `runner/cloud-init.yml` to `/etc/gitlab-runner/cloud-init.yml`. Fill in the runner token and the Hetzner API token.
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

- [ ] **Poller**, every 5 minutes (`*/5 * * * *`). Variables: `FACTORY_SCHEDULE=poll`, `FACTORY_TARGET=<target name>`, `SAST_DISABLED=true`, `SECRET_DETECTION_DISABLED=true`. It is the fallback when the label webhook does not fire: it starts a build pipeline for each work item labeled `factory_ready`, oldest first, while the target has fewer than 2 active runs. The build's event step checks the live labels and who added `factory_ready`, as it does for a webhook.
- [ ] **Retry**, every hour (`0 * * * *`). Variables: `FACTORY_SCHEDULE=retry`, `FACTORY_TARGET=<target name>`, `SAST_DISABLED=true`, `SECRET_DETECTION_DISABLED=true`. It resumes runs labeled `factory_waiting` (Claude's usage limit). The new build pipeline loads the record of the pipeline that hit the limit, puts back its clone and Claude session, and continues at the step that stopped. If that record or session is not usable, the work item gets `factory_blocked` with a comment.

Make one pair of schedules for each target. `FACTORY_SCHEDULE` accepts only `poll` or `retry`. The `SAST_DISABLED` and `SECRET_DETECTION_DISABLED` variables keep the security scans from running every 5 minutes.

## 9. Contract tests against real tools

Every push runs the contract tests against fakes. A manual job, `contract-real`, runs them against the real tools. Start it from Build > Pipelines > Run pipeline (a web pipeline), then press play on the job.

- [ ] Make a GitLab test project that holds no real work, with a default branch and one pipeline that no trigger started (for example a trivial `.gitlab-ci.yml`). The tests create tickets, push branches and open changes in it. Close them by hand now and then.
- [ ] `CONTRACT_GITLAB_PROJECT`: the path of that test project, for example `Ceresa/factory-contract-test`. A plain CI variable.
- [ ] `CONTRACT_GITLAB_TOKEN`: a token of a bot user with the `api` scope and Developer role (or higher) on the test project only. Masked and protected, type **Variable**. Never reuse `FACTORY_GITLAB_TOKEN`.
- [ ] Test webhooks: none yet. If a later contract needs one, add it to the test project only, never to a target repo.

## Local use

```bash
pnpm install
pnpm vitest run
pnpm tsx factory/steps/<step>.ts
```
