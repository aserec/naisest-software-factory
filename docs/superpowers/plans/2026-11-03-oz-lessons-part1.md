# Lessons from oz-for-oss, part 1 (A to E) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise the agent loop limit to 5, add a security checklist to the reviewer, stop runs whose work item or merge request a person closed, send changes to the code owner, and let each target repo add its own agent instructions.

**Architecture:** Each part goes through the existing seams (`Tracker`, `CodeHost`, `Repo`) so the GitLab, GitHub and GitHub Projects adapters all get it. New logic lives in two small modules (`factory/codeowners.ts`, `factory/local-instructions.ts`) and in `factory/steps/run.ts` for the closed-item rules. Parts F, G and H get their own plans after this one ships, because G reuses C's seams and H writes the files E reads.

**Tech Stack:** TypeScript (ESM, tsx), vitest, picomatch (already installed), zod config.

**Spec:** `docs/superpowers/specs/2026-11-03-oz-lessons-design.md` (parts A, B, C, D, E).

## Global Constraints

- Every write to GitLab or GitHub stays in step scripts. Agents get no new tokens or tools.
- Every new path works through the existing seams, so the GitLab, GitHub and GitHub Projects adapters all get it.
- Text written by people reaches models as data, inside a wrapper, after the injection check.
- Every new branch of logic leaves a test in the existing vitest style.
- `docs/how-it-works.md` and `GLOSSARY.md` are updated with each part.
- Agent loops get at most 5 rounds. The rebase limit of 3 in `factory/steps/merge.ts` stays.
- Repo-local instructions: at most 8,000 characters per file; the rest is cut.
- Run `pnpm test` and `pnpm typecheck` green before each commit.

## Deviation from the spec

- C says the blocked comment for a closed merge request "says who closed it". `Change` has no closer and GitHub only gives it through the events API, so the comment says the merge request was closed without a merge and links it. Add the closer later if people ask.

## Review Focus

1. The factory closes the work item itself in result-saved. No closed-item rule may fire on a work item whose state is `done`, or on a merge request that is merged.
2. A webhook or poll that sees a work item closed and then reopened: every closed-item decision re-reads the live state at the moment it acts.
3. A target with no CODEOWNERS file, a CODEOWNERS with comments, blank lines, GitLab `[Section]` headers, emails or groups: the reviewer falls back to `defaultApprover` and nothing throws.
4. An author who edits `.factory/author.md` in its own change: the next agent call in the same run still reads the base commit's text.
5. A code owner who is the factory bot, or who cannot be found on the host: skipped, never assigned.

Each line has its test in the owning task: 1 and 2 in Tasks 6 and 7, 3 and 5 in Task 5, 4 in Task 4.

---

### Task 1: Agent loop limit 5 (part A)

**Files:**
- Modify: `factory/loops.ts`, `factory/steps/code-review.ts:18,48`, `factory/steps/precommit-gate.ts:53-60`, `docs/how-it-works.md`
- Test: `factory/loops.test.ts`, `factory/steps/flow.test.ts`

**Interfaces:**
- Produces: `export const MAX_AGENT_ROUNDS = 5` in `factory/loops.ts`. Part H later replaces it with the target's `maxAgentRounds`.

- [ ] **Step 1: Change the tests to the new limit**

In `factory/loops.test.ts` rename and change the two limit tests:

```ts
test("five rounds with blocking findings block", async () => {
  const deps = fakeDeps({ reviews: [[B], [B], [B], [B], [B]] });
  expect(await codeReviewLoop(deps)).toEqual({ kind: "blocked", rounds: 5, open: ["bug"] });
  expect(deps.fixCalls).toHaveLength(4);
});
test("gate blocks after 5 failing rounds and names the command", async () => {
  const deps = fakeDeps({ results: { "pnpm test:unit": [false, false, false, false, false] } });
  const r = await precommitGate(deps, cmds);
  expect(r).toMatchObject({ kind: "blocked", rounds: 5 });
  expect(deps.fixCalls).toHaveLength(4);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run factory/loops.test.ts`
Expected: FAIL, `rounds: 3` received.

- [ ] **Step 3: Add `MAX_AGENT_ROUNDS = 5` and use it**

Default `maxRounds` of `codeReviewLoop` and `precommitGate` to `MAX_AGENT_ROUNDS`. In `code-review.ts` and `precommit-gate.ts` replace the literal `3` in `Math.min(..., 3)` and in the loop call with `MAX_AGENT_ROUNDS`, and fix the "counts as round 3" comments. Leave `merge.ts` alone.

- [ ] **Step 4: Run the whole suite**

Run: `pnpm test`
Expected: PASS. Any flow test that counted 3 review or gate rounds before blocking now counts 5; update its fixture lists (for example `reviews: [[B],[B],[B]]` becomes five) and its expected text "after 3 rounds" to "after 5 rounds".

- [ ] **Step 5: Update the docs and commit**

In `docs/how-it-works.md` change "At most 3 rounds" for code review and the gate, and "inside the same 3 review and 3 gate rounds", to 5. Keep "at most 3 times" for rebases.

```bash
git add factory/loops.ts factory/loops.test.ts factory/steps/code-review.ts factory/steps/precommit-gate.ts factory/steps/flow.test.ts docs/how-it-works.md
git commit -m "feat(loops): allow 5 rounds between agents"
```

### Task 2: Security checklist in the reviewer (part B)

**Files:**
- Modify: `prompts/review.md`
- Test: `factory/agents.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("the reviewer prompt carries the security checklist", () => {
  const p = reviewerPrompt("<ticket>t</ticket>", "diff");
  for (const s of ["[SECURITY]", "input validation", "authorization", "secrets", "dependencies", "insecure defaults"]) expect(p).toContain(s);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm vitest run factory/agents.test.ts -t "security checklist"`
Expected: FAIL.

- [ ] **Step 3: Add the checklist to `prompts/review.md`**

After the "Check:" line, add a section that asks the reviewer to check each changed hunk for exactly the spec's list: input validation and untrusted data (path traversal, SSRF, unsafe deserialization, unbounded input), output encoding (SQL, shell, HTML, Markdown, URLs, log lines), authentication and authorization, secrets (hardcoded, logged, in command lines), weak crypto and non-crypto randomness for tokens, new or loosened dependencies and curl-to-shell, logging of personal data or tokens, insecure defaults (TLS, CORS, cookies, file modes). Rules, in the prompt's plain style: a security finding's text starts with `[SECURITY]`; likely exploitable means `blocking: true`; a defense-in-depth idea means `blocking: false`; report only faults tied to changed lines; say nothing when nothing applies. Keep the one-JSON-array answer format.

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run factory/agents.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add prompts/review.md factory/agents.test.ts
git commit -m "feat(review): check every diff against a security checklist"
```

### Task 3: Read files from the base commit (seams for part E and D)

**Files:**
- Modify: `factory/seams.ts` (`Repo`, `CodeHost`), `factory/repo.ts`, `factory/adapters/gitlab-code-host.ts`, `factory/adapters/github-code-host.ts`, `factory/gitlab.ts`, `factory/fakes.ts`, `factory/steps/test-helpers.ts`
- Test: `factory/repo.test.ts`, `factory/adapters/gitlab-code-host.test.ts`, `factory/adapters/github-code-host.test.ts`

**Interfaces:**
- Produces:
  - `Repo.readBase(path: string): Promise<string | undefined>`: the file at the base commit the clone started from (HEAD of the factory's git dir), never the work tree. `undefined` when the path does not exist there.
  - `CodeHost.readFile(path: string): Promise<string | undefined>`: the file at the head of the target's base branch, read through the host API. `undefined` on 404.
  - `fakeCodeHost({ files?: Record<string, string> })` and the test-helpers repo option `baseFiles?: Record<string, string>` feed these two.

- [ ] **Step 1: Write the failing tests**

`repo.test.ts`: after `clone`, write `.factory/author.md` in the work tree with "edited"; `readBase(".factory/author.md")` returns the committed text, and `readBase("missing.md")` returns `undefined`. GitLab code host test: `readFile("CODEOWNERS")` calls `GET /projects/<id>/repository/files/CODEOWNERS/raw?ref=<baseBranch>` (path URL-encoded) and returns the body; a 404 returns `undefined`. GitHub code host test: `GET /repos/<r>/contents/CODEOWNERS?ref=<baseBranch>` with `Accept: application/vnd.github.raw`, same 404 rule.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run factory/repo.test.ts factory/adapters/gitlab-code-host.test.ts factory/adapters/github-code-host.test.ts`
Expected: FAIL, `readBase` / `readFile` is not a function.

- [ ] **Step 3: Implement**

`repo.ts`: `git --git-dir <gitDir> show HEAD:<path>` through the existing safe `git` helper; a "does not exist" or "exists on disk, but not in" error returns `undefined`, any other error throws. GitLab: add `GitLab.fileRaw(projectId, path, ref)` next to the other calls. GitHub: use `gh.call` and read the text. Add both methods to every fake.

- [ ] **Step 4: Run the suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add factory/seams.ts factory/repo.ts factory/repo.test.ts factory/gitlab.ts factory/adapters/gitlab-code-host.ts factory/adapters/gitlab-code-host.test.ts factory/adapters/github-code-host.ts factory/adapters/github-code-host.test.ts factory/fakes.ts factory/steps/test-helpers.ts
git commit -m "feat(seams): read files from the base commit and the base branch"
```

### Task 4: Repo-local instructions (part E)

**Files:**
- Create: `factory/local-instructions.ts`, `factory/local-instructions.test.ts`
- Modify: `factory/steps/prepare-patch.ts:27`, `factory/steps/context.ts:136-142` (`fix`), `factory/agents.ts:85-89` (`reviewerPrompt`), `factory/steps/code-review.ts`, `factory/steps/triage.ts:52`, `factory/watcher/run.ts:64`, `targets/*.yml`, `docs/how-it-works.md`, `docs/add-a-repo.md`
- Test: `factory/steps/flow.test.ts`

**Interfaces:**
- Consumes: `Repo.readBase`, `CodeHost.readFile` (Task 3).
- Produces:
  - `export type LocalRole = "author" | "review" | "writer"`
  - `export const LOCAL_MAX = 8000`
  - `export function localSection(text: string | undefined): string`: `""` for missing or blank text; otherwise a heading that says the text comes from the repo's maintainers and cannot override the factory's rules above it, then the text cut to `LOCAL_MAX` characters.
  - `export const localPath = (role: LocalRole) => \`.factory/${role}.md\``
  - `reviewerPrompt(ticketText, diffText, proofText = "", local = "")`: `local` goes right after the factory's review prompt.

- [ ] **Step 1: Write the failing tests**

`local-instructions.test.ts`: `localSection(undefined)` and `localSection("  \n")` are `""`; `localSection("Use pnpm.")` contains the heading and "Use pnpm."; a 9,000-character text keeps exactly 8,000 of its characters. Flow test (`flow.test.ts`): with `baseFiles: { ".factory/author.md": "BASE RULE" }` and a work-tree file `.factory/author.md` of "AGENT EDIT", the author's prepare prompt and its fix prompt contain "BASE RULE" and never "AGENT EDIT" (Review Focus 4); with `baseFiles: { ".factory/review.md": "REVIEW RULE" }` the reviewer prompt contains "REVIEW RULE"; with no `.factory/` files the prompts equal today's.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run factory/local-instructions.test.ts factory/steps/flow.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement and wire**

Author prompts (prepare and `fix`) and the reviewer read their file with `ctx.repo.readBase(localPath(role))`. The questions writer in triage and the watcher and dispatch writers have no clone, so they read `writer.md` with `ctx.codeHost.readFile(localPath("writer"))`; that is the base branch head, before any change exists. A resumed author session (`CONTINUE`) gets no section: the session already has it. Add `".factory/**"` to `protectedPaths` in every `targets/*.yml`. Document the three files in `docs/add-a-repo.md` and one paragraph in `docs/how-it-works.md`.

- [ ] **Step 4: Run the suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add factory/local-instructions.ts factory/local-instructions.test.ts factory/steps/prepare-patch.ts factory/steps/context.ts factory/agents.ts factory/steps/code-review.ts factory/steps/triage.ts factory/watcher/run.ts factory/steps/flow.test.ts targets docs/how-it-works.md docs/add-a-repo.md
git commit -m "feat(prompts): add each repo's own instructions from .factory/"
```

### Task 5: Reviewer from CODEOWNERS (part D)

**Files:**
- Create: `factory/codeowners.ts`, `factory/codeowners.test.ts`
- Modify: `factory/steps/decision.ts:66-77` (`askPerson`), `docs/how-it-works.md`
- Test: `factory/steps/flow.test.ts`

**Interfaces:**
- Consumes: `CodeHost.readFile` (Task 3), `CodeHost.branchDiff(sha)` (keys are the changed paths), `Tracker.trusted`, `Tracker.isFactory`.
- Produces:
  - `export const CODEOWNERS_PATHS = ["CODEOWNERS", ".gitlab/CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"]`
  - `export interface OwnerRule { pattern: string; owners: string[] }` (owners without `@`, users only)
  - `export function parseCodeowners(text: string): OwnerRule[]`
  - `export function ownersOf(rules: OwnerRule[], path: string): string[]`: the last matching rule wins.
  - `export function topOwners(rules: OwnerRule[], paths: string[]): string[]`: owners by how many paths they own, most first; ties in file order.
  - `export async function reviewer(ctx: StepContext, ticket: Ticket): Promise<PersonRef>` in `decision.ts`: ticket assignee, else the first of `topOwners` that is trusted and not the factory, else `defaultApprover`.

- [ ] **Step 1: Write the failing tests**

`codeowners.test.ts`, each its own test:
- comments, blank lines and `[Section]` / `^[Section]` headers are skipped;
- `*.ts @ana` then `/src/auth/ @ben`: `ownersOf(rules, "src/auth/login.ts")` is `["ben"]` (last match wins);
- `docs/` matches `docs/a/b.md`; `/build` is anchored and does not match `src/build`; a name with no slash like `Makefile` matches at any depth;
- `@org/team` and `ana@example.com` are dropped; a rule whose owners are all dropped keeps an empty list and still wins over earlier rules;
- `topOwners` with three files owned by `ana`, `ben`, `ana` returns `["ana", "ben"]`.

Flow tests: ticket with no assignee and `files: { CODEOWNERS: "src/ @owner" }` sends the change to `owner`; the same with `owner` untrusted, or `owner` being the factory bot, sends it to `approver` (Review Focus 5); no CODEOWNERS sends it to `approver`; a ticket assignee still wins (Review Focus 3).

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run factory/codeowners.test.ts factory/steps/flow.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Pattern to picomatch, gitignore style, `{ dot: true }`: strip one leading `/` and anchor; a pattern with no `/` except a trailing one gets `**/` in front; a trailing `/` becomes `/**`; a pattern without glob characters also matches `<pattern>/**`. `reviewer` reads the first existing path of `CODEOWNERS_PATHS`, takes the changed paths from `branchDiff` of the record's pushed head (`facts(ctx).gateHead`), and wraps `trusted` in a try/catch so a name the host does not know is skipped. `askPerson` assigns `await reviewer(ctx, ticket)`. `person()` stays for `block`. Document the order in `docs/how-it-works.md`, "The merge rule".

- [ ] **Step 4: Run the suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add factory/codeowners.ts factory/codeowners.test.ts factory/steps/decision.ts factory/steps/flow.test.ts docs/how-it-works.md
git commit -m "feat(decision): send a change to the code owner of its files"
```

### Task 6: Seams for closed items (part C)

**Files:**
- Modify: `factory/seams.ts`, `factory/adapters/gitlab-tracker.ts`, `factory/adapters/github-tracker.ts` (labels and Projects board), `factory/adapters/gitlab-code-host.ts`, `factory/adapters/github-code-host.ts`, `factory/gitlab.ts`, `factory/fakes.ts`
- Test: the adapter test files of those adapters

**Interfaces:**
- Produces:
  - `Tracker.clearState(ref: TicketRef): Promise<void>`: removes the state label (GitLab, GitHub labels) or clears the Status field (GitHub Projects). Marks stay.
  - `CodeHost.changeOfTicket(ticket: TicketRef): Promise<{ ref: ChangeRef; open: boolean; merged: boolean; url: string } | undefined>`: the newest change, in any state, whose source branch starts with `factory/<ticket>-`.

- [ ] **Step 1: Write the failing tests**

Per adapter: `clearState` removes every `factory_<state>` label and keeps the marks; on the Projects board it clears the Status field. `changeOfTicket("12")` on GitLab calls `GET /projects/<id>/issues/12/related_merge_requests` (every factory change says `Closes #12`), keeps those whose `source_branch` starts with `factory/12-`, and returns the newest by `created_at`, or `undefined` when none. GitHub calls `GET /repos/<r>/pulls?state=all&sort=created&direction=desc&per_page=100` and filters the same way; mark it `// ponytail: newest 100 pulls only, page further if a repo opens more between two polls`. Both: a branch `factory/123-x` must not match ticket `12`.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run factory/adapters`
Expected: FAIL.

- [ ] **Step 3: Implement in each adapter and in the fakes**

`fakeTracker` records cleared states; `fakeCodeHost` answers `changeOfTicket` from its `changes` map by branch prefix and gets `close(ref)` and `mergeByPerson(ref)` helpers for tests.

- [ ] **Step 4: Run the suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add factory/seams.ts factory/gitlab.ts factory/adapters factory/fakes.ts
git commit -m "feat(seams): clear a state and find a ticket's change"
```

### Task 7: End a run when its work item or merge request closes (part C)

**Files:**
- Modify: `factory/steps/run.ts` (`stopped`, new `endIfClosed`, `endRun` outcome), `factory/inbox.ts`, `factory/steps/context.ts` (`inbox`), `factory/steps/decision.ts`, `factory/steps/precommit-gate.ts`, `factory/steps/merge.ts`, `factory/run-events.ts` and the dashboard's run-outcome type if it lists outcomes, `factory/steps/poll.ts`, `docs/how-it-works.md`, `GLOSSARY.md`
- Test: `factory/inbox.test.ts`, `factory/steps/flow.test.ts`, `factory/steps/poll.test.ts`

**Interfaces:**
- Consumes: Task 6.
- Produces:
  - `makeInbox(tracker, ticket, since, stopCheck?, closedCheck?: () => Promise<boolean>)`: `closedCheck` is asked at the tracker cadence (once a minute); `true` makes `stop` true. A throwing check counts as not closed.
  - `export async function endIfClosed(ctx: StepContext): Promise<StepResult | undefined>` in `run.ts`. It reads the live ticket and `changeOfTicket`. Ticket closed and state not `done`: `clearState`, close the open change with the comment `This merge request was closed because a person closed work item #<ref>.`, `endRun(ctx, "closed")`, return `"stop"`. Ticket open, change closed and not merged: `block(ctx, "The merge request <url> was closed without a merge.", false)`. Otherwise `undefined`.
  - `endRun` outcome union gains `"closed"`.
  - `export async function endClosedRuns(ctx: StepContext): Promise<TicketRef[]>` in `run.ts`, for the poller: for each of `listClosed(100)` whose state is in `ACTIVE_STATES`, the same closed-ticket outcome; for each open ticket in `needs_approval`, `waiting` or `stopped` whose change is closed and not merged, state `blocked` and the same comment. Each ticket in its own try/catch, like `pollReady`.

- [ ] **Step 1: Write the failing tests**

- `inbox.test.ts`: a `closedCheck` that returns `true` gives `stop: true`; one that throws gives `stop: false`.
- Flow: a person closes the ticket while the author runs: the run ends with no `factory_stopped` label, no state label, the change closed with the comment, and a `run_end` of `closed`. A person closes the merge request before the decision step: the ticket is `factory_blocked` with the comment. A closed ticket before the gate's push: nothing is pushed.
- Review Focus 1: a run in result-saved that closes its own ticket ends `done`, and a merged change never triggers `endIfClosed`.
- Review Focus 2: the ticket's live state is read inside `endIfClosed`; a ticket closed in a webhook payload but open when `endIfClosed` reads it continues.
- `poll.test.ts`: a closed ticket labeled `factory_needs_approval` loses its state label and its open change is closed; an open `factory_needs_approval` ticket whose change was closed unmerged becomes `factory_blocked`; a `done` closed ticket is left alone.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run factory/inbox.test.ts factory/steps/flow.test.ts factory/steps/poll.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`stopped()` calls `endIfClosed` first and returns its result when it ends the run, so every stop path that came from a closed item ends correctly. `context.inbox` passes a `closedCheck` that is true when the ticket is closed or `changeOfTicket` gives a closed, unmerged change. Call `endIfClosed` at the start of `decision.run`, right before `commitAndPush` in the gate, and before `rebase` and `merge` in `merge.ts`. `poll.ts` `main` calls `endClosedRuns` before `handleRequests` and logs the tickets, like the other lines. Document in `docs/how-it-works.md` under "Stop and resume", and add **Closed run** to `GLOSSARY.md` under Control.

- [ ] **Step 4: Run the suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add factory/steps/run.ts factory/inbox.ts factory/inbox.test.ts factory/steps/context.ts factory/steps/decision.ts factory/steps/precommit-gate.ts factory/steps/merge.ts factory/run-events.ts factory/steps/poll.ts factory/steps/poll.test.ts factory/steps/flow.test.ts docs/how-it-works.md GLOSSARY.md
git commit -m "feat(run): end a run when a person closes its work item or merge request"
```
