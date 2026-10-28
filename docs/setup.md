# Setup

People do the steps below. They need accounts and tokens. Tick each box when done.

The GitLab project is `Ceresa/software-factory`.

## 1. GitLab project

- [ ] Create the GitLab project `Ceresa/software-factory`.
- [ ] Create a bot user. Make a personal access token with the `api` scope.
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
  - Runner tag: `factory`. Every job in `.gitlab-ci.yml` must use it.
- `runner/cloud-init.yml`: installs Docker on each new VM. Copy it to `/etc/gitlab-runner/cloud-init.yml` (the path in `user_data_file`).

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

## Local use

```bash
pnpm install
pnpm vitest run
pnpm tsx factory/steps/<step>.ts
```
