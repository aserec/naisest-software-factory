# Tool-agnostic dashboard and factory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every vendor-specific piece of the dashboard and the factory's shared code behind seams, so a later tool change is one adapter plus one line of config.

**Architecture:** The factory keeps `factory/compose.ts` as its composition root. Its leftovers (secret names, harness list, Claude-only code, sandbox homes, ticket refs, Team-plan rule) get declared by adapters instead of named in shared code. The dashboard gets `dashboard/src/server/seams.ts` (interfaces), `dashboard/src/server/adapters/*` (today's GitLab, GitHub, worker and Grafana code, moved), and `dashboard/src/server/compose.ts`, the only dashboard file that reads the env switches.

**Tech Stack:** TypeScript, Node 24, vitest 4, zod, Next.js 15 with Auth.js (next-auth v5), pnpm workspace (`.` and `dashboard`).

**Spec:** `docs/superpowers/specs/2026-11-04-tool-agnostic-design.md`

## Global Constraints

- No new vendor adapter. No change to `install.sh`, `local-*.sh`, `runner/`, `deploy/`, the job image, `factory/hetzner.ts`, `factory/rules.ts` patterns or `factory/codeowners.ts` paths.
- Behavior stays the same for every current setup: GitLab-only, GitHub-only, mixed board, `ci: local`, `ci: gitlab`. The one intended change: GitHub targets get GitHub names and links on the run page.
- No deployment needs a new env variable. Secret names stay as they are (`FACTORY_GITLAB_TOKEN`, `FACTORY_GITHUB_TOKEN`, `TEAMS_WEBHOOK_URL`, `GL_TOKEN` on the worker).
- No plugin framework: a plain map from name to constructor, as `ADAPTERS` in `factory/compose.ts`.
- Dashboard env switches (`FACTORY_CI`, `GITLAB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_ID`, `GRAFANA_URL`, the target files' `tracker`) are read only in `dashboard/src/server/compose.ts`.
- No page, component or route under `dashboard/src/app` or `dashboard/src/components` names a vendor, in code or comments.
- Security rules of spec section 7 stay: origin check and a fresh rights check on every control action, trigger token only in a request body, separate cancel and read tokens, every harness home on the sandbox deny list, every secret given to `addKnownSecrets`.
- Each dashboard seam (Tasks 8 to 11) gets `dashboard/src/server/contracts/<seam>.contract.ts` and a small in-memory fake, following `factory/contracts/*.contract.ts`. The contract runs against the fake and against each real adapter with a fake `fetch`, in that task's test step.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Checks: factory `pnpm test && pnpm typecheck` from the repo root; dashboard `pnpm --filter factory-dashboard test && pnpm --filter factory-dashboard typecheck`.

## Review Focus

1. A session cookie issued before Task 10 (no `signIn` field, or `provider: "github"`) keeps working until it expires. It maps to the `gitlab` or `github` sign-in adapter. Test in Task 10.
2. An open change branch made before Task 6 (`factory/12-fix-login`) is still found by `changeOfTicket` and `recentChanges` for ticket `12`. Test in Task 6.
3. A ticket ref that is unsafe in a branch name (`a/b`, `x--y`, `a b`, empty) makes `changeBranchPrefix` throw before anything is pushed. Test in Task 6.
4. An old `label_change` event in the database (`to: "factory_running"`) reads as state `running`, and an unknown value (`to: "foo"`) reads as no state, not a crash. Test in Task 9.
5. A board with a GitLab target while `GITLAB_URL` or `GITLAB_READ_TOKEN` is unset leaves that target out and still shows the GitHub targets. Test in Task 8.

---

## Part A: factory

### Task 1: Provider keys from one helper, in the worker and in the GitLab CI check

The worker fix is already in the working tree (`factory/worker.ts` `envSecrets`, test "a step gets the key of every provider in seams.yml, and no other variable" in `factory/worker.test.ts`). This task moves the list into a shared helper, uses it in `compose.ts` and `ci.test.ts`, and commits.

**Files:**
- Modify: `factory/config.ts`, `factory/worker.ts`, `factory/compose.ts:103`, `factory/ci.test.ts:20`
- Test: `factory/config.test.ts`, `factory/ci.test.ts`

**Interfaces:**
- Produces: `providerKeys(seams: SeamsConfig): string[]` in `factory/config.ts`: every `keyEnv` of `seams.providers` plus `"BERGET_API_KEY"`, without duplicates, in that order.

- [ ] **Step 1: Write the failing test** in `factory/config.test.ts`

```ts
test("providerKeys lists every provider key once, then the Jev key", () => {
  const seams = loadSeams();
  const twice = { ...seams, providers: { ...seams.providers, again: { ...seams.providers.tensorx, name: "again" } } };
  expect(providerKeys(twice)).toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "TENSORX_API_KEY", "BERGET_API_KEY"]);
});
```

- [ ] **Step 2: Run** `pnpm exec vitest run factory/config.test.ts`. Expected: FAIL, `providerKeys` is not exported.
- [ ] **Step 3: Implement `providerKeys`** in `factory/config.ts`. Replace `envSecrets` in `factory/worker.ts` with it. In `factory/compose.ts:103`, replace `env.BERGET_API_KEY, ...Object.values(seams.providers).map((p) => env[p.keyEnv])` with `...providerKeys(seams).map((k) => env[k])`.
- [ ] **Step 4: Change `factory/ci.test.ts:20`** to `...providerKeys(loadSeams()).map(passed),` so a provider added to `seams.yml` fails this test until every job in `.gitlab-ci.yml` passes its key. (My call: the jobs' `>-` scripts are literal strings that YAML anchors cannot splice, so the test is the guard. The spec allows this as the minimum.)
- [ ] **Step 5: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 6: Commit**

```bash
git add factory/config.ts factory/config.test.ts factory/worker.ts factory/worker.test.ts factory/compose.ts factory/ci.test.ts
git commit -m "fix(worker): pass every provider key from seams.yml to the steps"
```

### Task 2: Adapters declare their secret

**Files:**
- Create: `factory/secrets.ts`
- Modify: `factory/compose.ts:28-110`, `factory/worker.ts:25`, `factory/adapters/gitlab-ci.ts:46`, `factory/steps/jev-shadow.ts:38-39`
- Test: `factory/secrets.test.ts`, existing `factory/compose` tests in `factory/steps/flow.test.ts`, `factory/worker.test.ts`, `factory/steps/jev-shadow.test.ts`

**Interfaces:**
- Produces, in `factory/secrets.ts` (a leaf module: no imports from adapters):
  - `ADAPTER_SECRETS: { tracker: Record<string, string>; codeHost: Record<string, string>; chat: Record<string, string> }` with values `tracker: { gitlab: "FACTORY_GITLAB_TOKEN", github: "FACTORY_GITHUB_TOKEN", "github-project": "FACTORY_GITHUB_TOKEN" }`, `codeHost: { gitlab: "FACTORY_GITLAB_TOKEN", github: "FACTORY_GITHUB_TOKEN" }`, `chat: { teams: "TEAMS_WEBHOOK_URL" }`. An adapter with no secret (chat `console`) has no entry.
  - `FILE_SECRETS: string[]`: every value of `ADAPTER_SECRETS`, once, then `"FACTORY_DASHBOARD_TOKEN"`. Equals today's `SECRETS` in `gitlab-ci.ts`.

- [ ] **Step 1: Write the failing tests** in `factory/secrets.test.ts`
  - `"every tracker, code host and chat adapter in compose has a secret entry or is console"`: imports `ADAPTER_NAMES` (Step 3) and asserts each name of `tracker`, `codeHost` is a key of the matching `ADAPTER_SECRETS` record, and each `chat` name is in `ADAPTER_SECRETS.chat` or equals `"console"`.
  - `"FILE_SECRETS keeps today's list"`: `expect(FILE_SECRETS).toEqual(["FACTORY_GITLAB_TOKEN", "FACTORY_GITHUB_TOKEN", "TEAMS_WEBHOOK_URL", "FACTORY_DASHBOARD_TOKEN"])`.
- [ ] **Step 2: Run** `pnpm exec vitest run factory/secrets.test.ts`. Expected: FAIL, module missing.
- [ ] **Step 3: Implement.** Create `factory/secrets.ts`. In `factory/compose.ts`, export `ADAPTER_NAMES = { tracker: Object.keys(ADAPTERS.tracker), codeHost: Object.keys(ADAPTERS.codeHost), chat: Object.keys(ADAPTERS.chat) }`. Replace lines 91-99 with: read each picked adapter's secret through `ci.secret(name)` once per distinct name, throw `` `${name} is not set` `` when a picked adapter's secret is missing, and pass the value to that adapter. Remove `tokenFor` and `usesGitLab`. The existing error texts `"FACTORY_GITLAB_TOKEN is not set"`, `"FACTORY_GITHUB_TOKEN is not set"` and `"TEAMS_WEBHOOK_URL is not set"` stay the same strings. `addKnownSecrets` gets every secret read. `gitlab-ci.ts` `SECRETS` becomes `FILE_SECRETS` (re-export or replace the import in `local-ci.ts`). `worker.ts` `FILE_SECRETS` becomes `Object.fromEntries(FILE_SECRETS.map((n) => [n, n === "FACTORY_GITLAB_TOKEN" ? "GL_TOKEN" : n]))` so the worker's env names do not change. `jev-shadow.ts` reads `env[ADAPTER_SECRETS.tracker[loadSeams().tracker]]` and its error names that variable.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS with no change to existing assertions.
- [ ] **Step 5: Commit** `refactor(factory): let each adapter declare the secret it reads`.

### Task 3: One harness registry, and harness homes on the deny list

**Files:**
- Create: `factory/harnesses.ts`, `factory/srt.ts`
- Modify: `factory/seams.ts:129`, `factory/adapters/claude-code.ts`, `factory/adapters/pi.ts:7,94`, `factory/sandbox.ts`, `factory/repo.ts:9`, `factory/config.ts:5-17,118`, `factory/types.ts:4`, `factory/compose.ts:114`, `factory/steps/context.ts:26`, `factory/fakes.ts:310`, `factory/steps/test-helpers.ts:181`
- Test: `factory/harnesses.test.ts`

**Interfaces:**
- Produces:
  - `Harness` in `factory/seams.ts` gains `readonly home: string`: the folder name, next to the clone, that holds the harness's sessions and config. `claudeCode.home = "claude-home"`, `pi.home = "pi-home"`, the fake harness `"fake-home"`.
  - `factory/srt.ts`: `export const SRT: string` (moved from `sandbox.ts`, same value). `pi.ts` and `repo.ts` import it from here, so no adapter imports `sandbox.ts`.
  - `factory/harnesses.ts`: `export const HARNESSES = { "claude-code": claudeCode, pi } satisfies Record<string, Harness>`, `export type HarnessName = keyof typeof HARNESSES`, `export const HARNESS_NAMES = Object.keys(HARNESSES) as [HarnessName, ...HarnessName[]]`.
  - `sandboxDenyRead(cwd: string): string[]` in `sandbox.ts` returns `["/proc", `${ROOT}/.git`, `${ROOT}.tmp`, ...Object.values(HARNESSES).map((h) => join(dirname(cwd), h.home))]`.
  - `harnessHome(h: Harness, cwd: string): string` in `sandbox.ts` = `join(dirname(cwd), h.home)`; `pi.ts` uses it in place of `piHome`. `piHome` is deleted.

- [ ] **Step 1: Write the failing tests** in `factory/harnesses.test.ts`
  - `"every registered harness home is on the sandbox deny list"`: for each `h` of `Object.values(HARNESSES)`, `expect(sandboxDenyRead("/w/run/target")).toContain(join("/w/run", h.home))`.
  - `"the deny list keeps today's entries"`: `expect(sandboxDenyRead("/w/run/target")).toEqual(expect.arrayContaining(["/proc", "/w/run/claude-home", "/w/run/pi-home"]))`.
  - `"router.yml accepts exactly the registered harness names"`: `loadRouter` on a router whose writer harness is `"codex"` throws a message containing `harness`.
- [ ] **Step 2: Run** `pnpm exec vitest run factory/harnesses.test.ts`. Expected: FAIL, module missing.
- [ ] **Step 3: Implement.** `config.ts`: `harness: z.enum(HARNESS_NAMES)`, and the API check reads `HARNESSES[c.harness].apis` (delete `HARNESS_APIS`). `types.ts`: `RoleChoice.harness: HarnessName` (type-only import). `compose.ts`: `harnesses: HARNESSES`. `context.ts`: `harnesses: Record<HarnessName, Harness>`. `test-helpers.ts` builds its map from `HARNESS_NAMES`. Keep the import graph acyclic: `sandbox.ts → harnesses.ts → adapters → srt.ts`, never back into `sandbox.ts` at module load.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `refactor(factory): one harness registry, and each harness's home on the deny list`.

### Task 4: Claude-only code into the Claude adapter, and sandbox rules out of `.claude/`

**Files:**
- Create: `factory/sandbox-rules.json`, `factory/fixtures/claude-settings.json`
- Modify: `factory/agents.ts`, `factory/adapters/claude-code.ts`, `.claude/factory-settings.json`, `factory/sandbox.ts:6`, `factory/repo.ts:34-36`
- Move tests: the `factorySettings` cases of `factory/agents.test.ts` and `factory/inbox.test.ts:133-135` to `factory/adapters/claude-code.test.ts`

**Interfaces:**
- Produces:
  - `factory/sandbox-rules.json`: `{ "network": { "allowedDomains": [<today's five domains>] }, "filesystem": { "denyRead": ["/proc"] } }`.
  - `SANDBOX_RULES_PATH` in `factory/sandbox.ts` points at it. `repo.ts` `sandboxSettings` reads `allowedDomains` from it.
  - `.claude/factory-settings.json` keeps `permissions` and the `sandbox` flags (`enabled`, `failIfUnavailable`, `allowUnsandboxedCommands`, `autoAllowBashIfSandboxed`, `network.strictAllowlist`) and drops `network.allowedDomains` and `filesystem.denyRead`.
  - In `factory/adapters/claude-code.ts`: `ClaudeRun`, `ClaudeResult`, `INBOX_HOOK`, `CLAUDE_SETTINGS_PATH` (renamed from `SETTINGS_PATH`), and `factorySettings(env, hooksDir, cwd, inboxFile?, preview?)` with the same signature and output. It merges `allowedDomains` from `sandbox-rules.json` into `settings.sandbox.network`.
  - `factory/agents.ts` keeps `Finding`, `HOOKS_DIR`, `TSX_IMPORT`, `wrapTicket`, `wrapRequest`, `runCommand`, `guardReady`, `parseFindings`, `reviewerPrompt`, and no `Claude` name.

- [ ] **Step 1: Pin today's output.** Before any change, write `factory/fixtures/claude-settings.json` from `JSON.stringify(factorySettings({ CLAUDE_CONFIG_DIR: "/cfg", HOME: "/home/a" }, "/opt/hooks", "/w/run/target", "/w/run/inbox.jsonl", true), null, 2)`, then replace the absolute `INBOX_HOOK` and `TSX_IMPORT` paths in it with the placeholders `<INBOX_HOOK>` and `<TSX_IMPORT>`.
- [ ] **Step 2: Write the test** `"the Claude settings stay exactly as before the split"` in `factory/adapters/claude-code.test.ts`: the same call, stringified with the two placeholders put back, `toEqual` the fixture. Also `"repo sandbox settings keep the same allowed domains"`: `sandboxSettings("/w/run/target", "/h").network.allowedDomains` equals the fixture's `sandbox.network.allowedDomains`.
- [ ] **Step 3: Run** `pnpm exec vitest run factory/adapters/claude-code.test.ts`. Expected: PASS against today's code (it pins behavior).
- [ ] **Step 4: Move and split** as in Interfaces. Update imports in `inbox.test.ts`, `agents.test.ts` and `claude-code.ts`.
- [ ] **Step 5: Run** `pnpm test && pnpm typecheck` and `git grep -n -i claude factory/agents.ts factory/sandbox.ts factory/repo.ts`. Expected: tests PASS; grep shows only the `claude-home`-free comments, or nothing.
- [ ] **Step 6: Commit** `refactor(factory): keep Claude-only settings in the Claude adapter`.

### Task 5: `onlyHarness` on a provider replaces the Team-plan key name

**Files:**
- Modify: `factory/config.ts:14,36,98,119`, `factory/seams.ts:118`, `seams.yml` (team-plan line), `factory/config.test.ts:43-45`

**Interfaces:**
- Produces: `Provider.onlyHarness?: HarnessName` in `factory/seams.ts`; schema `onlyHarness: z.enum(HARNESS_NAMES).optional()`.

- [ ] **Step 1: Rewrite the test** `"a provider with onlyHarness serves only that harness, and never the judge"` in `factory/config.test.ts`: the two current `edited(...)` cases now expect the message `provider team-plan works only with harness claude-code`. Add a case: a copy of `seams.yml` with `onlyHarness: pi` on `tensorx` makes `loadRouter` pass for the pi roles and `loadSeams` throw for `judgeModel` on `tensorx`.
- [ ] **Step 2: Run** `pnpm exec vitest run factory/config.test.ts`. Expected: FAIL on the new messages.
- [ ] **Step 3: Implement.** Delete `TEAM_PLAN_KEY`. `loadRouter`: `if (p.onlyHarness && c.harness !== p.onlyHarness) throw new Error(`${field}: provider ${c.provider} works only with harness ${p.onlyHarness}`)`. `loadSeams`: throw `seams.yml judgeModel: provider ${name} works only with harness ${h}` when the judge provider has `onlyHarness`. `seams.yml`: add `onlyHarness: claude-code` to `team-plan`.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `refactor(config): name the harness a provider is limited to`.

### Task 6: Ticket refs that are not numbers

**Files:**
- Modify: `factory/seams.ts:94-95`, `factory/steps/precommit-gate.ts:84`
- Test: `factory/seams.test.ts` (create)

**Interfaces:**
- Produces, in `factory/seams.ts`:
  - `changeBranchPrefix(ticket: TicketRef): string`: throws unless `ticket` matches `/^[A-Za-z0-9._-]+$/` and has no `--`. A ref of digits only gives `factory/<ref>-` (today's format). Any other ref gives `factory/<ref>--`.
  - `ticketOfBranch(branch: string): TicketRef | undefined`: `/^factory\/(\d+)-(?!-)/` first, then `/^factory\/([A-Za-z0-9._-]+?)--/`.
- [ ] **Step 1: Write the failing tests** in `factory/seams.test.ts`
  - `ticketOfBranch("factory/12-fix-login")` is `"12"`; `ticketOfBranch("factory/ABC-12--fix-login")` is `"ABC-12"`; `ticketOfBranch("factory/ABC-12-fix")` is `undefined`; `ticketOfBranch("main")` is `undefined`.
  - `changeBranchPrefix("12")` is `"factory/12-"`; `changeBranchPrefix("ABC-12")` is `"factory/ABC-12--"`; `"factory/123-x".startsWith(changeBranchPrefix("12"))` is `false`; `"factory/ABC-120--x".startsWith(changeBranchPrefix("ABC-12"))` is `false`.
  - For each of `"a/b"`, `"x--y"`, `"a b"`, `""`: `expect(() => changeBranchPrefix(ref)).toThrow()`.
  - Round trip: for `"7"` and `"PROJ-7"`, `ticketOfBranch(changeBranchPrefix(ref) + "slug")` equals `ref`.
- [ ] **Step 2: Run** `pnpm exec vitest run factory/seams.test.ts`. Expected: FAIL on the non-numeric cases.
- [ ] **Step 3: Implement** both functions. `precommit-gate.ts:84` builds the branch as `` `${changeBranchPrefix(ref)}${slug(...)}` ``.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS, including the code host tests that use numeric refs.
- [ ] **Step 5: Commit** `feat(seams): accept ticket refs that are not numbers`.

### Task 7: Neutral words in prompts and the glossary

**Files:**
- Modify: `prompts/fix.md:6`, `prompts/prepare.md:9`, `prompts/request.md:7`, `GLOSSARY.md` (Work item entry), `factory/seams.ts:5` comment (may stay)

- [ ] **Step 1:** Replace "do not call GitLab" with "do not call the code host or the tracker" in the three prompts. Change the Work item definition to "An issue in the target's tracker that a person sets ready to ask the factory for a change."
- [ ] **Step 2: Run** `git grep -n -i gitlab prompts/ GLOSSARY.md` (only `prompts/humanizer.md` example text, if any, may remain) and `pnpm test`. Expected: PASS (prompt snapshot tests, if any, updated).
- [ ] **Step 3: Commit** `docs: name the tracker and code host, not GitLab, in prompts and the glossary`.

## Part B: dashboard

### Task 8: Board seam, states and links

**Files:**
- Create: `dashboard/src/server/seams.ts`, `dashboard/src/server/compose.ts`, `dashboard/src/server/adapters/gitlab-tracker.ts`, `dashboard/src/server/adapters/github-tracker.ts`
- Modify: `package.json` exports (add `"./seams": "./factory/seams.ts"`), `dashboard/src/server/targets.ts`, `dashboard/src/app/api/board/route.ts`, `dashboard/src/components/board.tsx`, `dashboard/src/app/runs/[run]/page.tsx`
- Move tests: board cases of `dashboard/src/server/gitlab.test.ts` and `github.test.ts` to `dashboard/src/server/adapters/gitlab-tracker.test.ts` and `github-tracker.test.ts`
- Test: `dashboard/src/server/compose.test.ts`, `dashboard/src/components/board.test.tsx`

**Interfaces:**
- Produces, in `dashboard/src/server/seams.ts`:
  - `import type { FactoryState } from "software-factory/seams"`; `export const STATES: FactoryState[] = ["ready", "running", "waiting", "needs_info", "needs_approval", "done", "stopped", "blocked"]`.
  - `export type Risk = "trivial" | "low" | "medium" | "high"`.
  - `export interface BoardRow { target: string; ticket: string; title: string; state: FactoryState; url: string; updatedAt: string; risk?: Risk }`.
  - `export interface Tracker { readonly name: string; rows(targets: TargetInfo[]): Promise<BoardRow[]>; ticketUrl(target: TargetInfo, ticket: string): string }`. `name` is the display name: `"GitLab"`, `"GitHub"`. `rows` throws `NotSetUp` when its address or read token is missing.
- `TargetInfo` in `targets.ts` becomes `{ name; projectPath; stuckMinutes; tracker: string; codeHost: string; githubRepo?: string; githubProject?: number }`. `tracker` and `codeHost` default to `"gitlab"`. `githubIssues` and `github` are deleted.
- Produces, in `dashboard/src/server/compose.ts`:
  - `getBoard(): { board(): Promise<BoardRow[]> }`: one instance, 15-second shared cache as today. It groups targets by `tracker`, calls each adapter's `rows` for its targets, drops a group whose adapter throws `NotSetUp`, and lets any other error fail the board, as today.
  - `trackerOf(t: TargetInfo): Tracker` and `codeHostName(t: TargetInfo): string` (`{ gitlab: "GitLab", github: "GitHub" }[t.codeHost]`).
- The GitLab tracker reads `GITLAB_URL` with no default, and throws `NotSetUp` when it or `GITLAB_READ_TOKEN` is missing. The GitHub tracker reads `GITHUB_URL` (default `https://github.com`) and `GITHUB_API_URL` (default `https://api.github.com`). `github-tracker.ts` serves both `github` and `github-project` (`githubProject` set).
- The board route returns `changeUrl` where it returned `mrUrl` (`changeUrl: r?.mrUrl`; the db field keeps its name).

- [ ] **Step 1: Write the failing tests** in `dashboard/src/server/compose.test.ts`
  - `"a mixed board shows GitLab and GitHub targets, each with its own link"`: fake `fetch` answers one GitLab issue labeled `factory_ready` for target `a` (tracker `gitlab`) and one GitHub issue labeled `factory_running` for target `b` (tracker `github`). Expect two rows, states `"ready"` and `"running"`, `url` from each API, and `trackerOf(b).ticketUrl(b, "5")` equal `"https://github.com/o/r/issues/5"`.
  - `"a GitLab target with no GITLAB_URL is left out and the GitHub target still shows"` (Review Focus 5).
  - `"codeHostName gives the target's code host name"`: `"GitHub"` for `codeHost: "github"`, `"GitLab"` when the key is missing.
- [ ] **Step 2: Run** `pnpm --filter factory-dashboard exec vitest run src/server/compose.test.ts`. Expected: FAIL, modules missing.
- [ ] **Step 3: Implement** the seam, the two adapters (moved code from `gitlab.ts` `fetchBoard` and `github.ts` `board`, rows mapped to `FactoryState`), `compose.ts`, and the `targets.ts` change. `board.tsx` keys its `STATE` names and sides by `FactoryState` and imports `STATES` from the seam. The run page uses `trackerOf(target)` for the work item link and "Open the work item in {tracker.name}", `codeHostName(target)` for "Review and merge in {name}", and `item?.state === "needs_approval"`.
- [ ] **Step 4: Run** dashboard tests and typecheck. Expected: PASS, with `board.test.tsx` updated from `factory_*` to `FactoryState` values.
- [ ] **Step 5: Commit** `refactor(dashboard): a board seam with one adapter per tracker`.

### Task 9: CI seam

**Files:**
- Create: `dashboard/src/server/adapters/gitlab-ci.ts`, `dashboard/src/server/adapters/local-ci.ts`
- Delete: `dashboard/src/server/gitlab.ts`, `dashboard/src/server/gitlab-instance.ts`, `dashboard/src/server/worker.ts` (code moved)
- Modify: `dashboard/src/server/compose.ts`, `dashboard/src/server/loop.ts`, `dashboard/src/instrumentation.ts`, `dashboard/src/app/api/dispatches/route.ts`, `dashboard/src/app/api/runner/route.ts`, `dashboard/src/app/api/jobs/[job]/log/route.ts`, `dashboard/src/app/api/runs/[run]/[action]/route.ts`, `dashboard/src/server/db.ts:229-232`, `dashboard/src/components/runner-view.tsx`, `dashboard/src/components/run-controls.tsx`, `dashboard/src/components/run-timeline.tsx`
- Move tests: `gitlab.test.ts` job, log, cancel, dispatch and import cases to `adapters/gitlab-ci.test.ts`; `worker.test.ts` to `adapters/local-ci.test.ts`; `loop.test.ts` renames

**Interfaces:**
- Produces, in `dashboard/src/server/seams.ts`:
  - `export interface Job { job: string; name: string; run: string; startedAt: string; runner?: string }`.
  - `export interface Ci { runningJobs(): Promise<Job[]>; jobLog(job: string): Promise<string>; cancel(run: string): Promise<void>; startDispatch(target: string): Promise<void>; importEvents(db: Db): Promise<number> }`.
- `getCi(): Ci` in `compose.ts`: `FACTORY_CI === "local"` gives the local adapter, else GitLab CI. One instance.
- The local adapter's `runningJobs` and `jobLog` throw `NotSetUp("The worker shows no job list or job log here. Read the worker's own log.")`.
- `LoopDeps` in `loop.ts`: `{ db: Db; ci: Pick<Ci, "cancel" | "importEvents" | "startDispatch">; now: Date }`.
- `db.label(run)` is renamed `db.state(run): FactoryState | undefined`: it strips a `factory_` prefix and returns the rest only when it is in `STATES`.
- The jobs log route checks `job` against `/^[\w.-]+$/` (400 otherwise). The GitLab adapter keeps its own numeric check.

- [ ] **Step 1: Write the failing tests**
  - `dashboard/src/server/db.test.ts`: `"an old label_change reads as a state, and an unknown one as none"` (Review Focus 4): events with `to: "factory_running"` give `state(run) === "running"`; `to: "foo"` gives `undefined`.
  - `dashboard/src/server/adapters/local-ci.test.ts`: `"the worker has no job list or job log, so both say not set up"`: both reject with `NotSetUp`.
  - `dashboard/src/server/compose.test.ts`: `"FACTORY_CI=local picks the worker"`: with `FACTORY_CI=local`, `getCi().runningJobs()` rejects with `NotSetUp`.
- [ ] **Step 2: Run** the dashboard tests. Expected: FAIL.
- [ ] **Step 3: Implement.** Move the code, rename `cancelPipeline` to `cancel` and `pipeline` to `run` in `Job`, the runner view says "run" where it says "pipeline", and the run controls and timeline compare `FactoryState` values.
- [ ] **Step 4: Run** dashboard tests and typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `refactor(dashboard): a CI seam for GitLab CI and the local worker`.

### Task 10: Sign-in seam

**Files:**
- Create: `dashboard/src/server/adapters/gitlab-sign-in.ts`, `dashboard/src/server/adapters/github-sign-in.ts`
- Modify: `dashboard/src/server/auth.ts`, `dashboard/src/server/control-user.ts`, `dashboard/src/server/compose.ts`, `dashboard/src/app/sign-in/page.tsx`
- Move tests: `dashboard/src/server/auth.test.ts` role cases to the two adapter test files

**Interfaces:**
- Produces, in `dashboard/src/server/seams.ts`:
  - `export interface SessionUser { userId: number; username: string; signIn: string }`.
  - `export interface SignIn { readonly id: string; readonly name: string; provider(): Provider /* next-auth provider config */; check(account: { access_token?: string }, profile: unknown): Promise<{ user: SessionUser } | { refused: string }>; canAct(user: SessionUser): Promise<true | { refused: string }>; messages: Record<string, string> }`. `refused` is a key of `messages`.
- `signIns(): SignIn[]` in `compose.ts`: GitLab when `GITLAB_OAUTH_CLIENT_ID` is set, GitHub when `GITHUB_OAUTH_CLIENT_ID` is set, in that order. The dev login stays in `auth.ts`, outside the seam.
- The JWT and session carry `signIn` in place of `provider?: "github"`. Reading an old token: `provider === "github"` gives `signIn: "github"`; no `provider` and no `signIn` gives `signIn: "gitlab"`.
- The sign-in error URL is `/sign-in?error=<id>.<key>`; the page shows `signIns().find(id).messages[key]`, else "Sign in failed. Try again."
- `controlUser` calls `signIns().find((s) => s.id === who.signIn)?.canAct(who)` and returns 403 with the message when refused. No vendor name in `control-user.ts`.
- The rules stay: GitLab needs access level 30 or more on `FACTORY_PROJECT_ID`, read again on every action, with today's refusal texts. GitHub needs `admin` or `write` on any GitHub target's repo.

- [ ] **Step 1: Write the failing tests**
  - `dashboard/src/server/auth.test.ts`: `"a session token from before the sign-in seam keeps its sign-in"` (Review Focus 1): the `session` callback on `{ userId: 1, username: "a", loginAt: now }` gives `signIn: "gitlab"`; on `{ ..., provider: "github" }` gives `signIn: "github"`.
  - `dashboard/src/server/compose.test.ts`: `"only sign-ins with a client id are on"`: with only `GITHUB_OAUTH_CLIENT_ID` set, `signIns().map((s) => s.id)` is `["github"]`.
  - `dashboard/src/server/control-user.test.ts` (create): `"a GitHub user without write access gets 403 with the GitHub message"`, using a fake `fetch`.
- [ ] **Step 2: Run** the dashboard tests. Expected: FAIL.
- [ ] **Step 3: Implement** the two adapters from today's `checkRole`, `memberLevel`, `canAct`, `canActOnGitHub` and the provider configs; `authConfig.providers` maps `signIns()`; the page renders one button per `signIns()` entry with `Sign in with {s.name}`; the dev button says "Dev sign-in".
- [ ] **Step 4: Run** dashboard tests and typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `refactor(dashboard): a sign-in seam for GitLab and GitHub`.

### Task 11: Host metrics seam

**Files:**
- Create: `dashboard/src/server/adapters/grafana.ts` (moved from `dashboard/src/server/grafana.ts`)
- Modify: `dashboard/src/server/compose.ts`, `dashboard/src/app/api/runner/route.ts`, `dashboard/src/components/runner-view.tsx`
- Move tests: `grafana.test.ts` to `adapters/grafana.test.ts`

**Interfaces:**
- Produces, in `dashboard/src/server/seams.ts`: `HostStat`, `LogLine` (moved), and `export interface HostMetrics { readonly sources: string[]; hostStats(): Promise<HostStat[]>; logs(q: { source: string; host?: string; minutes: number }): Promise<LogLine[]> }`.
- `getHostMetrics(): HostMetrics` in `compose.ts`: Grafana when `GRAFANA_URL` is set, else a `none` adapter with `sources: []` whose two calls throw `NotSetUp` with today's Grafana text. The Grafana adapter's `sources` is `["docker", "gitlab-runner", "system"]`.
- The runner route returns `sources` with the rest, and `runner-view.tsx` takes the list from the response. An unknown `source` from the URL falls back to `sources[0]`.

- [ ] **Step 1: Write the failing tests**: `compose.test.ts` `"no GRAFANA_URL gives no log sources and a not-set-up answer"`; `runner-view.test.tsx` renders the sources from props, not a constant.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** dashboard tests and typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `refactor(dashboard): a host metrics seam for Grafana`.

### Task 12: Guard against vendor words in pages and components

**Files:**
- Create: `dashboard/src/vendor-words.test.ts`
- Modify: whatever the test finds, comments included

- [ ] **Step 1: Write the test** `"pages, components and routes name no vendor"`: read every `.ts`/`.tsx` file under `dashboard/src/app` and `dashboard/src/components` that is not a `*.test.*` file, and expect no match of `/gitlab|github|grafana|loki|\bpipeline|\bMR\b|mrUrl|factory_|\/-\/issues|merge request/i`. Report the file and line of each match.
- [ ] **Step 2: Run** `pnpm --filter factory-dashboard exec vitest run src/vendor-words.test.ts`. Expected: FAIL only on leftovers the earlier tasks missed. Fix each.
- [ ] **Step 3: Check the guard bites:** add `// GitLab` to `dashboard/src/components/shell.tsx`, run the test, see it FAIL, remove the line.
- [ ] **Step 4: Run** the full factory and dashboard checks from Global Constraints. Expected: PASS.
- [ ] **Step 5: Commit** `test(dashboard): keep vendor names out of pages and components`.
