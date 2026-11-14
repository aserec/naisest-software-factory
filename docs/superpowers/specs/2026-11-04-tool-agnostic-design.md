# Tool-agnostic dashboard and factory: design

Date: 2026-11-04. Builds on [2026-10-29-swappable-modules-design.md](2026-10-29-swappable-modules-design.md) and [2026-10-29-factory-dashboard-design.md](2026-10-29-factory-dashboard-design.md).

## 1. Why

The factory's steps already work through seams (`factory/seams.ts`), picked in `seams.yml` and built in `factory/compose.ts`. The rest of the repo does not. An audit on 2026-11-04 found tool names in the dashboard, in secret names, in the list of harnesses, in Claude-only code that sits in shared modules, and in prompts.

The owner wants to be able to change a tool later, for example GitLab to GitHub, or Claude Code and Pi to Codex, without a rewrite. No change of tool is planned now (owner, 2026-11-04). So this work moves today's code behind interfaces and builds no new vendor.

## 2. Goals

1. The dashboard gets seams, like the factory: board, CI, sign-in, host metrics, and links and names. One composition file in the dashboard picks the adapters, from the target files and the same env variables that switch the code today (section 5.6).
2. Each dashboard seam has the adapters the dashboard has today, and nothing more:
   - board: GitLab, GitHub, and GitHub Projects;
   - CI: GitLab CI and the local worker;
   - sign-in: GitLab and GitHub;
   - host metrics: Grafana and none.
3. A later swap is one new adapter file plus one line of config, in the dashboard as in the factory.
4. The factory leftovers from the audit are fixed (section 6).
5. Behavior stays the same for every current setup, with one exception. The run page shows the right vendor name and links for GitHub targets, which it gets wrong today.

## 3. Non-goals

- No new vendor adapter: no Jira, Bitbucket, Gitea, Codex, OpenCode, GitHub Actions or Datadog.
- No change to the infrastructure. This covers Hetzner and `factory/hetzner.ts`, `.gitlab-ci.yml` as the only CI file, `install.sh`, `local-factory.sh`, `local-run.sh`, `runner/`, `deploy/` and the job image. Swapping these is a deploy choice, not code coupling.
- No change to the secret scrubber patterns in `factory/rules.ts` or to the CODEOWNERS paths in `factory/codeowners.ts`. They list vendors on purpose.
- The sandbox for gate commands stays `@anthropic-ai/sandbox-runtime`.
- `.gitlab-ci.yml` does not pass `FACTORY_GITHUB_TOKEN` to its jobs, so GitHub targets do not work on `ci: gitlab` today. That gap exists already and stays out of scope.

## 4. Anti-goals

The work fails, even if it runs, if any of these hold:

- A vendor word reaches a dashboard page or component outside an adapter: `GitLab`, `GitHub`, `pipeline`, `MR`, `factory_*` label names, `/-/issues/`, `github.com`.
- The adapter choice is spread over routes and pages instead of one composition place in the dashboard, which mirrors `factory/compose.ts`.
- The seams turn into a plugin framework with a registry, discovery or dynamic loading. A plain map from name to constructor is enough. This is the same rule as the swappable-modules design.
- An adapter is weaker on security than the code it replaces. Section 7 lists what stays.
- A current setup breaks. Examples are a GitLab-only setup, a GitHub-only setup, a mixed board, `ci: local` and `ci: gitlab`.

## 5. Dashboard seams

Today the dashboard picks tools from env variables. `GITLAB_READ_TOKEN`, `GITHUB_OAUTH_CLIENT_ID` and `FACTORY_CI=local` each switch code paths, and those checks are spread over modules. `makeGitLab` in `dashboard/src/server/gitlab.ts` also builds the GitHub board. After this work, one composition file reads those inputs and builds the adapters (section 5.6). No other dashboard file reads them.

The interface sketches below show intent. The builder picks the exact names and types, but must keep each interface in factory words and about this small.

### 5.1 Board

Today it is `makeGitLab().board()`, with `makeGitHub().board()` inside it.

- `board(): BoardRow[]` holds every target's open work items in a factory state. A row's state is a `FactoryState` (`ready`, `running`, ...) from `factory/seams.ts`, not a `factory_*` label. The risk is `trivial | low | medium | high`.
- Each target uses the adapter its own `tracker` key names (`gitlab`, `github`, `github-project`), the same key the factory reads. A board can mix targets from several trackers. The 15-second cache stays, shared by every request.
- A target whose tracker has no read token is left out, as today. This is a "not set up" case, not a failure.

The pages and components that compare against `factory_*` strings, such as `board.tsx`, `run-controls.tsx`, `run-timeline.tsx` and the run page, switch to `FactoryState`. The run events keep the `label_change` type and their `factory_*` values, because events already saved in the database use them. The dashboard maps them to `FactoryState` when it reads them. Renaming the event type is out of scope.

### 5.2 CI

Today it is `getCi()`, which returns `makeGitLab()` or `makeWorker()`, while `getGitLab()` serves `jobLog` and `runningJobs`.

- `runningJobs()`, `jobLog(job)`, `cancel(run)`, `startDispatch(target)`, `importEvents(db)`.
- `FACTORY_CI` still picks the adapter, `gitlab` or `local`, read in the composition file only.
- The local worker has no running-job list or job log today. Its adapter throws `NotSetUp` for both, so the runner page shows its quiet "not set up" line, as it does for a missing Grafana. A worker endpoint for jobs and logs is out of scope.
- The words change: `cancelPipeline` becomes `cancel`, and the runner view says "run" where it says "pipeline". The CI adapter may name its own unit in its own error texts.

### 5.3 Sign-in

Today it is `dashboard/src/server/auth.ts`, with two hard-coded Auth.js providers, `checkRole` and `canAct` for GitLab, `canActOnGitHub` for GitHub, and a `provider === "github"` branch in `control-user.ts`.

- Each sign-in adapter gives an Auth.js provider config, a check at sign-in, and a check per control action ("may this person act"), each with its refusal text.
- A sign-in adapter is on when its OAuth client id is set, as today (section 5.6). The sign-in page shows one button per adapter that is on, with a name the adapter gives.
- The session records which adapter signed the person in, and `controlUser` asks that adapter. There is no vendor `if` in `control-user.ts`.
- The dev login stays as it is, outside the seam.
- The rules stay the same. GitLab needs the Developer role or higher on the factory project, checked again on every action. GitHub needs write, maintain or admin on the repo of any GitHub target.

### 5.4 Host metrics and logs

Today it is `dashboard/src/server/grafana.ts`, with the log sources `docker`, `gitlab-runner` and `system`.

- `hostStats()` and `logs(source, ...)`, plus the list of log sources, which comes from the adapter. The component stops hard-coding `SOURCES`.
- The adapters are `grafana` and `none`. The composition file picks `grafana` when `GRAFANA_URL` is set and `none` otherwise. `none` throws `NotSetUp`, which is today's behavior when `GRAFANA_URL` is missing.

### 5.5 Links and names

Today the run page builds the work item link by hand for each vendor and always says "Review and merge in GitLab". `targets.ts` writes `https://github.com` into the code. The GitLab default host `gitlab.example.com` sits in `dashboard/src/server/gitlab.ts:8`.

- The board adapter of a target gives the work item URL and the tracker's display name. The board rows already carry `url`. The run page uses the row's URL when it has one, and asks the target's adapter otherwise.
- The code host's display name, used in "Review and merge in <name>", comes from the target's `codeHost` adapter. The change URL already comes from the run record.
- The GitHub web and API hosts become settings with today's values as defaults, so GitHub Enterprise can work later. The GitLab host has no default in the code. It comes from `GITLAB_URL`, and a GitLab adapter with no `GITLAB_URL` is "not set up".

### 5.6 Config

The dashboard picks keep coming from the env variables each deployment sets today. The new part is that one composition file, which mirrors `factory/compose.ts`, reads them and maps them to adapter names. This is my call, after the builder check. `seams.yml` is a committed file that `install.sh` does not edit, and the dashboard image does not contain it. Moving the picks there would need edits to each deployment, `install.sh`, and the dashboard image. It would also break the anti-goal "a current setup breaks". For example, a committed `signIn: [gitlab]` would hide the GitHub button in a deployment that sets `GITHUB_OAUTH_CLIENT_ID` today.

| Seam | Picked by | Adapters |
|---|---|---|
| Board | the target file's `tracker` key; a target with no key uses `gitlab`, as today | `gitlab`, `github`, `github-project` |
| CI | `FACTORY_CI`: `local`, else `gitlab` | `gitlab`, `local` |
| Sign-in | each adapter whose OAuth client id is set | `gitlab`, `github` |
| Host metrics | `GRAFANA_URL` set or not | `grafana`, `none` |

The board default is a known limit. The factory uses `seams.yml`'s `tracker` when a target file has none. The dashboard cannot read `seams.yml`, so it keeps `gitlab`. The fix, when it matters, is to mount `seams.yml` into the dashboard.

Secrets and addresses stay env variables, as today: `GITLAB_URL`, `GITLAB_READ_TOKEN`, `GITLAB_CANCEL_TOKEN`, `FACTORY_TRIGGER_TOKEN`, `FACTORY_PROJECT_ID`, the OAuth client ids and secrets, `GITHUB_READ_TOKEN`, `GRAFANA_*`, `FACTORY_WORKER_URL`. No deployment needs a new variable. `install.sh`, the dashboard image and `deploy/` do not change.

## 6. Factory leftovers

1. **Secret names.** `factory/compose.ts` chooses tokens with `adapter === "gitlab" ? token : githubToken`, and `factory/worker.ts` and `factory/adapters/gitlab-ci.ts` list `FACTORY_GITLAB_TOKEN`, `FACTORY_GITHUB_TOKEN` and `TEAMS_WEBHOOK_URL` by name. Each tracker, code host and chat adapter declares the secret it needs, and the composition root and the worker read that list. The secret names themselves do not change, so no deployment needs new variables. The fallback in `factory/steps/jev-shadow.ts:38` uses the same source.
2. **Provider keys in GitLab CI.** `.gitlab-ci.yml` names `TENSORX_API_KEY` and `BERGET_API_KEY` in each job. The local worker already passes every `keyEnv` from `seams.yml` (done 2026-11-04, commit pending). GitLab CI cannot read `seams.yml` before the job starts, so the builder makes the jobs pass the provider keys through one shared YAML anchor or `variables:` block, and `factory/ci.test.ts` checks that every `keyEnv` in `seams.yml` is in it. This is the minimum. The file stays the only CI file.
   (Later decision: the judge is now `jev-celeris`, and `jev-berget` is gone. See [Celeris is the only Jev host](../../adr/2026-11-06-celeris-is-the-jev-host.md).)
3. **Closed list of harnesses.** The harness names are listed in `factory/config.ts:13`, `factory/config.ts:17`, `factory/types.ts:4` and `factory/compose.ts:114`. One map from name to harness, in one module, feeds all four. `config.ts` derives the zod enum and the API check from it.
4. **Claude-only code in shared modules.** `ClaudeRun`, `ClaudeResult`, `factorySettings` and `INBOX_HOOK` in `factory/agents.ts` move into `factory/adapters/claude-code.ts`, or into a file next to it. `agents.ts` keeps what every harness shares: `runCommand`, `wrapTicket`, `wrapRequest`, `guardReady`, `parseFindings` and the reviewer prompt.
5. **Gate sandbox settings in a Claude folder.** `.claude/factory-settings.json` holds the sandbox rules that the install and gate commands use, through `factory/repo.ts`, and also the Claude Code permissions. The builder splits it into a file that is not in a Claude folder, holding the shared sandbox rules, and the Claude permissions, which the Claude adapter adds. The merged settings the Claude agent gets must stay exactly the same, and a test must prove that.
6. **Harness home folders.** `sandboxDenyRead` in `factory/sandbox.ts:16` names `claude-home` and `pi-home`. Each harness declares its home folder, and the deny list is built from every registered harness, so a new harness cannot forget it. `piHome` moves to the Pi adapter.
7. **Team plan rule.** `TEAM_PLAN_KEY = "CLAUDE_CODE_OAUTH_TOKEN"` in `factory/config.ts:14` ties a rule to a key name. The provider entry in `seams.yml` gets an optional field that names the only harness allowed to use it, for example `onlyHarness: claude-code` on `team-plan`. The check reads that field. The judge rule at `config.ts:98` reads the same field, because a provider restricted to a harness cannot serve a plain model call.
8. **Numeric ticket refs.** `ticketOfBranch` in `factory/seams.ts:91` accepts only digits. It changes to accept any ticket ref that is safe in a branch name, such as `ABC-12`. The branch format becomes `factory/<ref>--<slug>` only if that is needed to keep `12` apart from `123`. The builder checks every caller and the existing open branches. Old branches must still parse. The callers are `factory/fakes.ts`, `factory/adapters/gitlab-code-host.ts:123` and `factory/adapters/github-code-host.ts:168`.
9. **Prompts.** `prompts/fix.md`, `prompts/prepare.md` and `prompts/request.md` say "do not call GitLab". They change to "do not call the code host or the tracker".
10. **Glossary and comments.** `GLOSSARY.md` defines a work item as "a GitLab issue". It changes to the tracker-neutral wording. Comments in `factory/seams.ts` that name GitLab as the example adapter may stay.

## 7. Security rules that stay

- Every control route checks the origin and the sign-in, and checks the person's rights again on each action. This includes a GitLab role removed after sign-in.
- The trigger token goes in the request body, never in a URL or an error text.
- The cancel token and the read token stay separate.
- No secret reaches an agent. The deny list for sandbox reads covers every harness home, the factory `.git` and the secret dir.
- `addKnownSecrets` still receives every secret the factory reads, so the scrubber hides them in logs.

## 8. Tests

- Each dashboard seam gets a small fake and one shared contract test that runs against the fake and against each real adapter with a fake `fetch`. The dashboard's current adapter tests, `gitlab.test.ts`, `github.test.ts`, `grafana.test.ts`, `worker.test.ts` and `auth.test.ts`, move to the new adapters and keep their cases.
- One test proves that a mixed board, with a GitLab target and a GitHub target, shows both, each with its own link and name.
- One test proves that the run page of a GitHub target says GitHub and links to the GitHub issue.
- A grep check in the test suite fails when a page, component or route under `dashboard/src/app` or `dashboard/src/components` names a vendor. It reads only those folders, not `dashboard/src/server/adapters`.
- The factory changes keep the full `pnpm test` and `pnpm typecheck` green. The settings test for item 5 compares the merged Claude settings before and after the change.

## 9. Left to the builder

- The exact interface names and types, and the folder layout. `dashboard/src/server/adapters/` mirroring `factory/adapters/` is the suggestion.
- The order of the work. The dashboard seams and the factory leftovers are independent, and each item in section 6 can be its own commit.
- Whether the dashboard and the factory share the `FactoryState` type through `software-factory/...` exports or a copy.
