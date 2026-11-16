# Software Factory

## Install

1. Install Docker with Compose v2: [Docker Engine](https://docs.docker.com/engine/install/) on Linux, [Docker Desktop](https://docs.docker.com/desktop/) on macOS and Windows. The installer does not install it for you.
2. Get the values in the table below ready.
3. Run:

   ```bash
   git clone https://gitlab.example.com/Ceresa/software-factory.git
   cd software-factory && ./install.sh
   ```

   On Windows, run these commands in Git Bash (it comes with [Git for Windows](https://git-scm.com/download/win)) or in WSL2. `install.sh` is a bash script, and cmd and PowerShell cannot run it.

The installer asks for each value, with where to get it, and writes `deploy/.env` (never in git). It then starts the dashboard behind HTTPS and the factory worker (`factory/worker.ts`, seams.yml `ci: local`), which runs each step of a run in a new container. Where those containers run is the answer to "Where tickets run": `machine` (the default) on this machine, `hetzner` on a new Hetzner VM per run that the worker deletes after the run, or `gitlab`, where a GitLab Runner starts one Hetzner VM per CI job in place of the worker (set `ci: gitlab` in seams.yml). Run `./install.sh` again after `git pull` to update. To change a value, edit `deploy/.env` and run it again.

Which values you need depends on three choices: where people sign in, which tracker each target uses (`tracker` in its target file) and what runs the factory (`FACTORY_CI`). A GitHub-only setup needs no GitLab value at all. The installer asks where your tickets and code live (gitlab, github or both, guessed from `targets/`) and asks only for those values.

**Always needed**

| Value | Where to get it |
| --- | --- |
| `DASHBOARD_HOST` | The name people open the dashboard at, e.g. `factory.example.com`, with a DNS A record to this machine and ports 80 and 443 open. `localhost` on your own computer. |

**What runs the factory: `FACTORY_CI`.** The installer sets it from "Where tickets run".

| `FACTORY_CI` | Use it when | Also needs |
| --- | --- | --- |
| `local` | The factory worker runs the steps (`machine` or `hetzner`, seams.yml `ci: local`). | `FACTORY_WORKER_URL` only when the worker is not at `http://worker:8080`. |
| `gitlab` | GitLab CI runs the steps (seams.yml `ci: gitlab`). | `GITLAB_URL`, `FACTORY_PROJECT_ID`, `GITLAB_READ_TOKEN`, `GITLAB_CANCEL_TOKEN`, `FACTORY_TRIGGER_TOKEN`. |
| not set | No CI is connected, for example the dashboard on your Mac next to `./local-factory.sh`. The dashboard then cancels no runs and starts no dispatch runs; the steps still honour a stop themselves. | Nothing. |

**With GitLab targets or GitLab sign-in**

| Value | Where to get it |
| --- | --- |
| `GITLAB_URL` | The address of your GitLab. |
| `FACTORY_PROJECT_ID` | The factory project's page in GitLab: the menu at the top right (three dots) > Copy project ID. GitLab sign-in checks membership of this project. |
| `GITLAB_OAUTH_CLIENT_ID`, `GITLAB_OAUTH_CLIENT_SECRET` | For GitLab sign-in. GitLab > User settings > Applications > Add new application. Name `Factory dashboard`, redirect URI `https://<DASHBOARD_HOST>/api/auth/callback/gitlab`, Confidential, scope `read_user` only. Copy the ID and the secret (shown once). |
| `GITLAB_READ_TOKEN` | Signed in as a read-only bot user, Reporter on the factory project and on every target project: User settings > Access tokens, scope `read_api`. |
| `GITLAB_CANCEL_TOKEN` | Only with `FACTORY_CI=gitlab`. The factory project > Settings > Access tokens: role Developer, scope `api`. Only used to cancel a stuck pipeline. |

**With GitHub targets or GitHub sign-in**

| Value | Where to get it |
| --- | --- |
| `GITHUB_READ_TOKEN` | A token that reads every GitHub target repo (and its Projects board for `github-project`). The board and GitHub sign-in use it. |
| `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` | For GitHub sign-in. GitHub > Settings > Developer settings > OAuth Apps > New OAuth App, callback URL `https://<DASHBOARD_HOST>/api/auth/callback/github`. |

**Optional: the Runner page.** All four values, or none.

| Value | Where to get it |
| --- | --- |
| `GRAFANA_URL` | The address of your Grafana. |
| `GRAFANA_TOKEN` | Grafana > Administration > Service accounts: add one with the Viewer role, then Add token. |
| `LOKI_UID`, `METRICS_UID` | Grafana > Connections > Data sources > the Loki source, and the metrics source: the last part of each one's URL. |

**With `worker` (the default)**

| Value | Where to get it |
| --- | --- |
| `GL_TOKEN` | Signed in as the factory bot, which reads tickets and pushes and merges in the target repo ([setup.md section 1](docs/setup.md#1-gitlab-project)): User settings > Access tokens, scope `api`. |
| `TENSORX_API_KEY` | Your TensorX account > API keys. The writer and the chat models run there (`router.yml`, `seams.yml`). |
| `CLAUDE_CODE_OAUTH_TOKEN` | Run `claude setup-token`, signed in to the Claude Team plan. The author, the reviewer and the fixer run on it (`router.yml` provider `team-plan`). See [the ADR](docs/adr/2026-10-29-claude-team-plan-auth.md). |
| `CELERIS_API_KEY` | The judge that answers triage, duplicate and risk questions (`seams.yml` `judge: jev-celeris`). Without it a step stops with an error. |
| `SLACK_WEBHOOK_URL` or `TEAMS_WEBHOOK_URL` | The one that matches `chat` in `seams.yml`. Slack: an app with Incoming Webhooks on, added to the channel for factory notices. Teams: a Workflows flow "Post to a channel when a webhook request is received". |

**With `hetzner`.** GitLab also needs the CI variables and poll schedules in [setup.md](docs/setup.md) sections 1, 2, 7 and 8.

| Value | Where to get it |
| --- | --- |
| Runner token | The factory project > Settings > CI/CD > Runners > New project runner, with the tag `factory`. Copy the token (`glrt-...`). |
| Hetzner API token | Hetzner Cloud console > your project > Security > API tokens > Generate, with Read & Write. |

These two go into `deploy/runner/config.toml`, not into `deploy/.env`.

**Made for you:** `AUTH_SECRET` (sign-in cookies) and `FACTORY_DASHBOARD_TOKEN`. With `hetzner`, copy `FACTORY_DASHBOARD_TOKEN` from `deploy/.env` into the factory project's CI variables (masked, protected, type File).

## How it works

See [docs/how-it-works.md](docs/how-it-works.md) for the run, its steps and the switches, and [docs/setup.md](docs/setup.md) for the GitLab and CI set-up.
