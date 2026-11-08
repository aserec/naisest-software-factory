# Add a repo

Do these steps for each new target repo. Replace `<name>` with the target name.

## 1. In the target repo

- [ ] Turn on work items (issues): Settings > General > Visibility, project features.
- [ ] Add the bot as a member. Use Maintainer if your GitLab is Free.
- [ ] Create and protect the base branch (for example `develop`).
- [ ] Give the bot merge rights on the base branch, and not on `master` (Premium). On Free the bot is a Maintainer and can still merge into `master`, so only apply's target check guards it.
- [ ] Set the project's merge method to "Fast-forward merge" and the squash setting to "Allow", "Encourage" or "Require". The merge method applies to `master` too.
- [ ] Give the base branch no required approval rule for factory merge requests. The bot cannot approve its own merge request, so a required approval makes every auto merge fail.
- [ ] Run a branch pipeline on pushes to the base branch, and a merge request pipeline for merge requests into it. Without the branch pipeline, verify waits an hour and blocks every merge.
- [ ] Set the `.factory.yml` commands on the dashboard's Settings page, or add `.factory.yml` at the repo root in a merge request that a person reviews. The Settings page wins when both exist. Required keys: `install`, `lint`, `test`, `build`. Optional: `smoke`. See `docs/targets/react_frontend.factory.yml`.
  ```yaml
  install: pnpm install --frozen-lockfile
  lint: pnpm lint
  test: pnpm test
  build: pnpm build
  ```
- [ ] Optional: add `.factory/author.md`, `.factory/review.md` and `.factory/writer.md` to tune the agents. The factory adds each file to the matching prompt: `author.md` for the author (also its commit message and merge request text), `review.md` for the reviewer, `writer.md` for the questions comment and the watcher and dispatch ticket writers. A missing or empty file changes nothing. Only the first 8,000 characters are read. The factory reads `author.md` and `review.md` from the commit it cloned, so the author cannot change its own instructions. It reads `writer.md` from the head of the base branch. The files cannot override the factory's rules. Add them in a merge request that a person reviews: `.factory/**` is a protected path, so a change to them always goes to a person.
- [ ] Optional: change the numbers the factory decides with on the dashboard's Settings page. A key you leave at its default follows later changes to the default.
  ```yaml
  diffRiskMax: 4              # whole number, 2 to 10. A diff_risk above it needs a person.
  autoMergeConfidenceMin: 0.8 # 0.5 to 1. Jev 2 must be at least this sure.
  clarityMin: 6               # whole number, 2 to 10. A ticket below it gets questions.
  maxAgentRounds: 5           # whole number, 1 to 10. Review and gate rounds.
  ```
- [ ] Add the webhook (Settings > Webhooks) for issue, comment and merge request events. Each event starts a pipeline; a comment starts a run only when it has the line `@factory resume`. URL:
  ```text
  https://gitlab.example.com/api/v4/projects/<factory project id>/ref/main/trigger/pipeline?token=<trigger token>&variables[FACTORY_PIPELINE]=build&variables[FACTORY_TARGET]=<name>&variables[SAST_DISABLED]=true&variables[SECRET_DETECTION_DISABLED]=true
  ```
  - Every label change, also the factory's own, starts a pipeline. The `event` job stops at once when the event is not a person adding `factory_ready` (or a person merging a factory MR), and the later jobs skip.
  - The trigger token must be the one the bot owns, stored in the factory project as the File-type variable `FACTORY_TRIGGER_TOKEN`.
  - Keep webhook settings Maintainer-only. Whoever sees the URL can start factory pipelines.
  - If label events do not start the `event` job, keep the webhook off and rely on the poller.

## 2. In this repo

- [ ] Add `targets/<name>.yml`. Copy `targets/react_frontend.yml`. Set `projectPath`, `baseBranch` (the branch the factory clones, targets and merges into, for example `develop`; required), `defaultApprover` (a real GitLab username), `jobImage` (must be the image in `.gitlab-ci.yml`), `maxChangedLines` (optional; leave it out for no line limit), `protectedPaths` (`.factory/**` is always added) and `dependencyFiles`.
- [ ] Open a merge request here. `<name>` must match the file name. Other names stop the job.

## 3. Schedules

Create three schedules for the target (Build > Pipeline schedules). Sign in as the bot, so the bot owns them. Target branch `main`.

- [ ] **Poll**: `* * * * *`. Variables: `FACTORY_SCHEDULE=poll`, `FACTORY_TARGET=<name>`, `SAST_DISABLED=true`, `SECRET_DETECTION_DISABLED=true`.
- [ ] **Retry**: `0 * * * *`. Variables: `FACTORY_SCHEDULE=retry`, `FACTORY_TARGET=<name>`, `SAST_DISABLED=true`, `SECRET_DETECTION_DISABLED=true`.
- [ ] **Self-improvement job**: `0 6 * * 1`. Variables: `FACTORY_SCHEDULE=improve`, `FACTORY_TARGET=<name>`, `SAST_DISABLED=true`, `SECRET_DETECTION_DISABLED=true`. It reads a week of corrections and proposes edits to the target's `.factory/` files (see docs/how-it-works.md). With `ci: local` the worker runs it by itself and needs no schedule.

## 4. Check

- [ ] Add `factory_ready` to a small test work item. The `event` job should run (from the webhook or within a minute from the poller).

## A repo on GitHub

The target file picks `tracker: github-project` (or `github`) and `codeHost: github`, which replace `seams.yml` for that target only. See `targets/musicapp_webapp.yml`.

- [ ] Until the factory has its own GitHub account, a token of a person's account works with `sharedAccount: true` in the target: that person's Ready counts, and the factory tells its own comments apart by the AI line.
- [ ] Set `githubRepo` (`owner/name`), `githubProject` (the board number from its URL) and `defaultApprover` (a GitHub login).
- [ ] Give the board a single-select `Status` field whose columns are factory states: `Ready`, `Running`, `Waiting`, `Stopped`, `Needs approval`, `Needs info`, `Info answered`, `Blocked`, `Done`.
- [ ] Set `FACTORY_GITHUB_TOKEN` for the worker. A board owned by a user (not an organization) needs a classic token with scopes `repo` and `project`; otherwise a fine-grained token with Contents, Issues, Pull requests and Projects read and write, and Checks and Commit statuses read.
- [ ] Run GitHub Actions (or another check) on pull requests into the base branch and on pushes to it. Without them every change waits an hour, then goes to a person.
- [ ] Allow squash merges in the repo settings, and add `.factory.yml` as in section 1.
- [ ] The dashboard lists a GitHub target's tickets from its board (or its factory_* labels) with `GITHUB_READ_TOKEN`, a token that reads the target repos and the board (classic: `repo` and `read:project`).
- [ ] GitHub sign-in: add an OAuth app (GitHub > Settings > Developer settings > OAuth Apps) with the callback URL `https://<dashboard>/api/auth/callback/github`, and set `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET` in the dashboard's env. A user gets in with write access to the repo of any GitHub target. The GitLab button shows only when `GITLAB_OAUTH_CLIENT_ID` is set.
