# Install the factory, with or without an AI agent

There are two ways to run the factory. Both use the same value names, listed in the table [Values](#values) below.

- **On your computer:** `./sf` runs the dashboard, the factory and the fixer. They all read one file, `.env` at the repo root.
- **On a server with Docker:** `./install.sh` asks for the values and writes `deploy/.env`. See the README's Install section.

## On your computer

### What you need first

- Node 22 or later, pnpm 9, git, openssl, curl.
- An AI coding agent that can run shell commands in this repo, such as Claude Code. Without one, follow the prompt's steps yourself.

### Steps

1. Clone the repo and open your agent in it.
2. Paste the prompt below into the agent. It runs `./sf setup`, asks you only for the values your setup needs, and writes them into `.env`.
3. Run `./sf start`, then open https://localhost:3000.

### The prompt

```text
Install the local software factory in this repo. Follow these steps in order and stop to ask me when a step needs a value only I have.

1. Run ./sf setup. It installs the packages, makes .env from .env.example, fills AUTH_SECRET and FACTORY_DASHBOARD_TOKEN with random values, and runs ./sf doctor.
2. Make sure targets/ holds at least one <name>.yml. If it is empty, ask me which tracker my repo uses, copy the sample in factory/fixtures/targets/ that matches it (core_app.yml for GitHub, react_frontend.yml for GitLab), and ask me for my repo, which goes in githubRepo on GitHub or projectPath on GitLab.
3. Ask me where people sign in to the dashboard: GitHub, GitLab, or only the local dev sign-in (AUTH_DEV_LOGIN=1).
4. Run ./sf doctor. It lists each value .env still lacks for my targets. Add the sign-in values from my answer to step 3 as well.
5. For each missing value, tell me where to get it, using the "Where to get it" column of the Values table in docs/install-with-ai.md, and wait for me to paste it. Write it as a NAME=value line with no quotes. Keep each value already set. Never print a secret back to me, and never commit .env.
6. Run ./sf doctor until it says .env has every value. Then run ./sf start and ./sf status. Dashboard, Factory and Fixer must say on. If one says off, read .cache/dashboard.log, .cache/factory.log or .cache/fixer.log, fix the cause, and run ./sf restart.
7. Ask me whether the factory should start when I log in to this Mac. If yes, run ./sf autostart on.
8. Tell me what you set, what is still empty, and the URL https://localhost:3000.
```

### Daily use

| Command | What it does |
| --- | --- |
| `./sf start` | Runs `./sf doctor`, starts the dashboard, waits until it answers, then starts the factory for every target in `targets/` and the fixer. A part that already runs stays as it is. |
| `./sf stop` | Stops all three. A ticket in progress runs again on the next start. |
| `./sf restart` | Stop, then start. Run it after you add a target or change `.env`. |
| `./sf status` | Shows on or off for each part and for autostart, and the tickets that run now. |
| `./sf doctor` | Lists each value `.env` lacks for your targets. |
| `./sf logs` | Follows the three logs in `.cache/`. |
| `./sf autostart on` or `off` | Starts everything when you log in to this Mac, with a launchd agent. Its log is `.cache/autostart.log`. |
| `pnpm dashboard` | Runs only the dashboard, in the foreground, from the repo root. |

## Values

The Where column says which file needs the value: `.env` on your computer, `deploy/.env` on a server, or both. Leave a value empty when your setup does not need it. Write `localhost:3000` in place of `<DASHBOARD_HOST>` on your computer.

### Always

| Name | Where | Where to get it |
| --- | --- | --- |
| `AUTH_SECRET` | both | Made for you by `./sf setup` and `./install.sh`. Signs the sign-in cookies. |
| `FACTORY_DASHBOARD_TOKEN` | both | Made for you. The factory sends its events to the dashboard with it. With `hetzner` or `gitlab`, copy it into the factory project's CI variables (masked, protected, type File). |
| `DASHBOARD_URL` | both | `https://localhost:3000` on your computer, `https://<DASHBOARD_HOST>` on a server. |
| `TENSORX_API_KEY` | both | Your TensorX account > API keys. The writer and the chat models run there (`router.yml`, `seams.yml`). |
| `CELERIS_API_KEY` | both | The judge that answers triage, duplicate and risk questions (`seams.yml` `judge: jev-celeris`). Without it a step stops with an error. |
| `CLAUDE_CODE_OAUTH_TOKEN` | both | Run `claude setup-token`, signed in to the Claude Team plan. The author, the reviewer and the fixer run on it (`router.yml` provider `team-plan`). See [the ADR](adr/2026-10-29-claude-team-plan-auth.md). |
| `SLACK_WEBHOOK_URL` or `TEAMS_WEBHOOK_URL` | both | The one that matches `chat` in `seams.yml`. Slack: an app with Incoming Webhooks on, added to the channel for factory notices. Teams: a Workflows flow "Post to a channel when a webhook request is received". |
| `FACTORY_GIT_EMAIL` | both | Optional. The author email of the bot's commits. Empty: the account's no-reply email. |
| `DASHBOARD_DB` | `.env` | `../.cache/factory.db`. The path is relative to `dashboard/`. The server keeps its database in a Docker volume. |
| `AUTH_DEV_LOGIN` | `.env` | `1` gives a sign-in button with no account. Only on your own computer. |
| `DASHBOARD_HOST` | `deploy/.env` | The name people open the dashboard at, e.g. `factory.example.com`, with a DNS A record to the server and ports 80 and 443 open. `localhost` for Docker on your own computer. |

### With GitHub targets or GitHub sign-in

| Name | Where | Where to get it |
| --- | --- | --- |
| `FACTORY_GITHUB_TOKEN` | both | For GitHub targets (tracker `github` or `github-project`, codeHost `github`). A fine-grained token on the target repos: Contents, Issues and Pull requests read and write, Commit statuses and Checks read; for a board also Projects read and write. |
| `FACTORY_BOT_GITHUB_TOKEN` | both | Optional. The factory bot's classic token with the `repo` and `project` scopes, used for each target where the bot may push and edit the board. |
| `GITHUB_READ_TOKEN` | both | A token that reads every GitHub target repo and its Projects board. The board and GitHub sign-in use it. |
| `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` | both | For GitHub sign-in. GitHub > Settings > Developer settings > OAuth Apps > New OAuth App, callback URL `https://<DASHBOARD_HOST>/api/auth/callback/github`. |

### With GitLab targets or GitLab sign-in

| Name | Where | Where to get it |
| --- | --- | --- |
| `GL_TOKEN` | both | Signed in as the factory bot, which reads tickets and pushes and merges in the target repo ([setup.md section 1](setup.md#1-gitlab-project)): User settings > Access tokens, scope `api`. |
| `FACTORY_BOT_GITLAB_TOKEN` | both | Optional. The factory bot's token, scope `api`, for each target where the bot may push. |
| `GITLAB_URL` | both | The address of your GitLab. |
| `FACTORY_PROJECT_ID` | both | The factory project's page in GitLab: the menu at the top right (three dots) > Copy project ID. GitLab sign-in checks membership of this project. |
| `GITLAB_READ_TOKEN` | both | Signed in as a read-only bot user, Reporter on the factory project and on every target project: User settings > Access tokens, scope `read_api`. |
| `GITLAB_OAUTH_CLIENT_ID`, `GITLAB_OAUTH_CLIENT_SECRET` | both | For GitLab sign-in. GitLab > User settings > Applications > Add new application. Name `Factory dashboard`, redirect URI `https://<DASHBOARD_HOST>/api/auth/callback/gitlab`, Confidential, scope `read_user` only. Copy the ID and the secret (shown once). |

### What runs the factory on a server: `FACTORY_CI`

`./install.sh` sets it from "Where tickets run". On your computer `./sf` runs the steps, so leave it unset.

| `FACTORY_CI` | Use it when | Also needs |
| --- | --- | --- |
| `local` | The factory worker runs the steps (`machine` or `hetzner`, seams.yml `ci: local`). | `FACTORY_WORKER_URL` only when the worker is not at `http://worker:8080`. |
| `gitlab` | GitLab CI runs the steps (seams.yml `ci: gitlab`). | `GITLAB_URL`, `FACTORY_PROJECT_ID`, `GITLAB_READ_TOKEN`, `GITLAB_CANCEL_TOKEN`, `FACTORY_TRIGGER_TOKEN`. |
| not set | No CI is connected, as with `./sf`. The dashboard then cancels no runs and starts no dispatch runs; the steps still honour a stop themselves. | Nothing. |

### Server only

| Name | Where | Where to get it |
| --- | --- | --- |
| `GITLAB_CANCEL_TOKEN` | `deploy/.env` | Only with `FACTORY_CI=gitlab`. The factory project > Settings > Access tokens: role Developer, scope `api`. Only used to cancel a stuck pipeline. |
| `FACTORY_TRIGGER_TOKEN` | `deploy/.env` | Only with `FACTORY_CI=gitlab`: the bot's pipeline trigger token ([setup.md section 1](setup.md#1-gitlab-project)). The dashboard starts dispatch runs with it. |
| `FACTORY_DISPATCH_TOKEN` | `deploy/.env` | Made for you by `./install.sh`. Outside systems such as cron jobs send dispatches with it. |
| `HETZNER_TOKEN` | `deploy/.env` | With `hetzner`. Hetzner Cloud console > your project > Security > API tokens > Generate, with Read & Write. |
| Runner token | `deploy/runner/config.toml` | With `gitlab`. The factory project > Settings > CI/CD > Runners > New project runner, with the tag `factory`. Copy the token (`glrt-...`). |

### Optional: the Runner page

All four values, or none. They work in both files.

| Name | Where to get it |
| --- | --- |
| `GRAFANA_URL` | The address of your Grafana. |
| `GRAFANA_TOKEN` | Grafana > Administration > Service accounts: add one with the Viewer role, then Add token. |
| `LOKI_UID`, `METRICS_UID` | Grafana > Connections > Data sources > the Loki source, and the metrics source: the last part of each one's URL. |
