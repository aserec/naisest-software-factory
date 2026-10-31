# Develop Branch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The factory works only against the target's `develop` branch. It merges alone only auto-decision changes, as one `[AM]` squash commit, and rebases first when the branch is behind. Every other change waits for a person to press Merge.

**Architecture:** A required `baseBranch` in `targets/<name>.yml` feeds `CodeHost.baseBranch()`, which replaces `defaultBranch()` everywhere. The author agent writes `run/commit-message.md`. `commitMessage()` in the precommit gate cleans it, the gate saves it in the record, and apply squash merges with `[AM] ` plus that message. When the branch is behind, apply first has GitLab rebase it, and the rebased commit's added and removed lines must match the reviewed commit. Approvals are no longer events. Only a person's merge starts the finish run.

**Tech Stack:** TypeScript (ESM, Node 22), vitest, zod, pnpm, GitLab REST API v4.

**Spec:** `docs/superpowers/specs/2026-10-31-develop-branch-design.md`

## Global Constraints

- The factory never clones, targets, verifies or merges `master`. Every branch use goes through `CodeHost.baseBranch()`, which returns `target.baseBranch` (`develop` for react_frontend).
- `GitLab.getProject().defaultBranch` stays, for `decisionJob` only (the factory repo's own branch).
- GitLab details stay in `factory/gitlab.ts` and `factory/adapters/gitlab-code-host.ts`. Steps import nothing from `../gitlab`. Step files must pass `factory/steps/words.test.ts`: no `GitLab`, `iid`, `merge_request` or `mergeRequest` anywhere in `factory/steps/*.ts` (test files excepted), including block texts and comments.
- Only a decision of kind `auto` merges without a person. An approval starts nothing.
- Squash commit message: `` `[AM] ${commit.message}\nMerge request: ${changeUrl}` ``. Only apply adds `[AM]`. `commitMessage()` removes every `[AM]` (any case) the agent wrote.
- Commit title rule: matches `/^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^()]+\))?!?: \S.*$/` and is at most 72 characters. Otherwise the title is the ticket title.
- No `[skip ci]` or `[ci skip]` (any case) anywhere in a commit message or change title. Use the existing `noSkipCi` in `factory/steps/precommit-gate.ts`.
- At most 3 rebases per apply run. A failed rebase, or a fourth rebase needed, sends the change to a person through `askPerson` (state `needs_approval`, change comment, assignee, Teams card), so the person's merge runs verify and closes the ticket. The factory never resolves conflicts.
- The change description keeps `Factory run <n>: <url>` as its first block. The adapter still runs it through `noQuickActions`.
- The label `factory_needs_approval` keeps its name.
- Commands: `pnpm test` (vitest run) and `pnpm typecheck` (tsc --noEmit). There is no lint script.
- Commit messages look like `feat(factory): resume blocked runs on ready` and end with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `factory/steps/poll.ts` and `local-factory.sh` hold unrelated uncommitted work. Never stage them. Stage only the files a task names.
- The change-proof work also edits `changeText`. If it lands first, keep its Proof section below the new "Commit message" section (spec 8.11).

## Review Focus

1. **A cut-off diff from GitLab** (`compare_timeout`, or an entry with `too_large` or `collapsed`) would give empty diff text on both sides and look like "no change". The adapter must throw instead. Test: Task 5, "a cut-off diff fails instead of reading as no change".
2. **A rebased commit that adds or drops a whole file** while every shared file still matches must not merge. Test: Task 5, the extra-file and empty-diff cases in "a rebased change whose added or removed lines differ…".
3. **A commit message file with CRLF line ends, no body, or a title one character over the limit.** The title must survive CRLF, and the 72/73-character edge must hold. Test: Task 3, "a missing or bad commit title falls back to the ticket title and keeps the body".
4. **A secret in the agent's commit message** must block before any push, because the message goes into the commit and the description. Test: Task 3, "a commit message that holds a secret blocks, and nothing is pushed".
5. **GitLab refuses a merge for a reason other than "behind"** (405, 409, or a pipeline rule). Apply must not loop on rebases. The error ends the step, and runStep blocks. Test: Task 5, "a merge GitLab refuses for another reason is not retried".

---

### Task 1: The target's base branch

**Files:**
- Modify: `targets/react_frontend.yml`, `factory/types.ts` (`Target`), `factory/config.ts` (`targetSchema`)
- Modify: `factory/seams.ts` (`CodeHost.defaultBranch` → `baseBranch`)
- Modify: `factory/adapters/gitlab-code-host.ts`, `factory/compose.ts:27`, `factory/gitlab.ts:180-186` (`revertMerge`)
- Modify: `factory/steps/triage.ts:46`, `factory/steps/prepare-patch.ts:6`, `factory/steps/verify.ts:4`
- Modify: `factory/fakes.ts`, `factory/steps/test-helpers.ts`, `factory/contracts/codeHost.real.test.ts`
- Test: `factory/config.test.ts`, `factory/adapters/gitlab-code-host.test.ts`, `factory/steps/flow.test.ts`

**Interfaces:**
- Produces:
  - `Target.baseBranch: string`
  - `CodeHost.baseBranch(): Promise<string>`: the branch the factory clones, targets and verifies. `defaultBranch()` is gone.
  - `makeGitLabCodeHost(gitlab: GitLab, projectPath: string, token: string, env: NodeJS.ProcessEnv, baseBranch: string): CodeHost` (Task 5 adds a last `sleep` parameter)
  - `GitLab.revertMerge(projectId: number, sha: string, base: string)`
  - `FakeCodeHostOptions.baseBranch?: string` (default `"develop"`), which replaces `defaultBranch`
  - `WorldOptions.baseBranch?: string`, which replaces `defaultBranch`. The world getter `cloned: string[]` holds every ref passed to `repo.clone`.

- [ ] **Step 1: Write the failing tests**

`factory/config.test.ts`:
```ts
test("a target names its base branch; a missing or empty one is refused", () => {
  expect(loadTarget("react_frontend").baseBranch).toBe("develop");
  expect(() => loadTarget("react_frontend", { baseBranch: "" })).toThrow(/targets\/react_frontend\.yml: baseBranch/);
  expect(() => loadTarget("react_frontend", { baseBranch: undefined })).toThrow(/baseBranch Required/);
});
```

`factory/adapters/gitlab-code-host.test.ts`:
- `host()` becomes `makeGitLabCodeHost(new GitLab("https://gl.example", "tok", fakeFetch), PATH, "tok", {}, "develop")`. The inline constructor in the `attach` describe gets the same `"develop"` argument.
- Replace "the default branch comes from the project, not from 'main'" with:
```ts
test("the base branch is the target's, not the project's default branch", async () => {
  expect(await host().baseBranch()).toBe("develop");
  expect(calls).toHaveLength(0);
});
```
- "the project is looked up once": call `h.commentChange("5", "a")` twice, with the route `routes["/projects/7/merge_requests/5/notes"] = {}`. Then `expect(calls.filter((c) => c.url === `/projects/${encodeURIComponent(PATH)}`)).toHaveLength(1)`.
- The openChange tests expect `target_branch: "develop"`, and their reuse routes return `target_branch: "develop"`. "An open change that targets another branch is refused" uses `target_branch: "master"` and expects `/master/`.
- The revert test expects `ref: "develop"` and `target_branch: "develop"`.

`factory/steps/flow.test.ts`:
- Rename "finish pipeline merges, waits for the default branch and closes the work item" to "finish pipeline merges, waits for the develop pipeline and closes the work item". Build the world as `fakeWorld({ mainPipeline: "success" })` and expect `w.mainPipelineRef` to be `"develop"`.
- "finish after a manual merge does not merge again and verifies the merge commit": drop `defaultBranch: "master"` and add `expect(w.mainPipelineRef).toBe("develop")`.
- New:
```ts
test("prepare patch and the questions agent clone the base branch", async () => {
  expect((await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" } }))).cloned).toEqual(["develop"]);
  expect((await runBuildPipeline(fakeWorld({ jev1: { clarity: 4 } }))).cloned).toEqual(["develop"]);
});
```
- "makeContext builds a context on the adapters seams.yml names": make it `async` and add `expect(await ctx.codeHost.baseBranch()).toBe("develop")`. This proves compose passes `target.baseBranch`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run factory/config.test.ts factory/adapters/gitlab-code-host.test.ts factory/steps/flow.test.ts`
Expected: FAIL. `baseBranch` is undefined, or `host().baseBranch is not a function`.

- [ ] **Step 3: Implement**

- `targets/react_frontend.yml`: add `baseBranch: develop` below `projectPath`. `targetSchema`: `baseBranch: z.string().min(1)`.
- In the adapter, `baseBranch: async () => baseBranch`. `openChange` upserts against `baseBranch`, and `revert` passes `baseBranch`. The cached project is used only for its `id`.
- `revertMerge`: the new branch starts from `base`, and the MR targets `base`. The description becomes `` `The ${base} pipeline failed after ${sha}. This reverts it.` ``
- `compose.ts`: pass `target.baseBranch`. `codeHost.real.test.ts`: pass `(await gitlab.getProject(path)).defaultBranch` (the contract project has no develop branch) and clone `await host.baseBranch()`.
- In the steps, `triage.ts` `questions`, `prepare-patch.ts` and `verify.ts` call `ctx.codeHost.baseBranch()`.
- Fake: `baseBranch: async () => o.baseBranch ?? "develop"`. World: `repo.clone: async (ref) => void cloned.push(ref)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test && pnpm typecheck`
Expected: PASS, no type errors. `grep -rn "defaultBranch()" factory` finds nothing.

- [ ] **Step 5: Commit**

```bash
git add targets/react_frontend.yml factory/types.ts factory/config.ts factory/config.test.ts factory/seams.ts factory/gitlab.ts factory/compose.ts factory/adapters/gitlab-code-host.ts factory/adapters/gitlab-code-host.test.ts factory/steps/triage.ts factory/steps/prepare-patch.ts factory/steps/verify.ts factory/fakes.ts factory/steps/test-helpers.ts factory/steps/flow.test.ts factory/contracts/codeHost.real.test.ts
git commit -m "feat(factory): clone, target and verify the target's base branch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Only a person's merge starts the finish run

**Files:**
- Modify: `factory/seams.ts` (`FactoryEvent`, remove `CodeHost.approvedByTrusted`)
- Modify: `factory/adapters/gitlab-tracker.ts` (`parseEvent`), `factory/adapters/gitlab-code-host.ts` (remove `approvedByTrusted` and the `DEVELOPER` import), `factory/gitlab.ts` (remove `approvedBy`)
- Modify: `factory/steps/event.ts` (`changeEvent`, `run`), `factory/steps/apply.ts:19-22`, `factory/steps/decision.ts:58`, `factory/teams.ts` (`KIND_TEXT`)
- Modify: `factory/fakes.ts`, `factory/steps/test-helpers.ts`
- Test: `factory/adapters/gitlab-tracker.test.ts`, `factory/adapters/gitlab-code-host.test.ts`, `factory/gitlab.test.ts`, `factory/teams.test.ts`, `factory/steps/flow.test.ts`

**Interfaces:**
- Consumes: the Task 1 world (fake base branch `"develop"`).
- Produces:
  - `FactoryEvent` has `{ kind: "merged"; ticket: TicketRef; change: ChangeRef; actor: PersonRef }` and no `"approved"` kind.
  - No `approvedByTrusted` or `approvedBy` anywhere.
  - In test-helpers, `mrEvent(actor: PersonRef = "dev"): FactoryEvent` always returns the merged event for ticket 8, change 5.

- [ ] **Step 1: Write the failing tests**

`gitlab-tracker.test.ts`: replace "an approval of a factory change gives approved; a merge gives merged" with:
```ts
test("an approval of a factory change is ignored; a merge gives merged", () => {
  expect(tracker().parseEvent(load("mr-approved.json"))).toEqual({ kind: "ignored", reason: "not-added" });
  const p = load("mr-approved.json");
  p.object_attributes.action = "merge";
  expect(tracker().parseEvent(p)).toMatchObject({ kind: "merged", ticket: "8", change: "5" });
});
```
`teams.test.ts`: `expect(card.body[0].text).toBe("Needs review and merge: react_frontend #8")`.
Delete the `approvedByTrusted` describe in `gitlab-code-host.test.ts` and the test "approvedBy lists approver ids" in `gitlab.test.ts`.

`flow.test.ts`:
- Replace "a developer's approval of a waiting MR starts the finish pipeline with the build record" and "a manual merge starts the finish pipeline with apply skipped" with:
```ts
test("a person's merge of a waiting MR starts the finish pipeline with the build record and apply skipped", async () => {
  const w = await runBuildPipeline(fakeWorld({ payload: mrEvent(), state: "needs_approval" }));
  expect(w.finishVars).toEqual({ kind: "finish", ticket: "8", change: "5", buildRun: "41", skipApply: true });
  expect(w.states).toEqual(["running"]);
  expect(w.claudeCalls).toBe(0);
});
test("GitLab's approval event starts nothing", async () => {
  const payload = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/mr-approved.json", import.meta.url)), "utf8"));
  const w = fakeWorld({ payload, state: "needs_approval" });
  w.tracker.parseEvent = makeGitLabTracker(undefined as never, w.ctx.target.projectPath).parseEvent; // the real webhook parser
  await runBuildPipeline(w);
  expect(w.finishTriggered).toBe(false);
  expect(w.record.steps[0].data).toMatchObject({ start: false, reason: "not-added" });
  expect(w.states).toEqual(["needs_approval"]);
});
```
- Rename "approvals by the bot or a non-developer, or of an MR not waiting for a person, start nothing" to "merges by the bot or a non-developer, or of an MR not waiting for a person, start nothing". Its cases become `mrEvent(BOT)`, `mrEvent()` with `actorLevel: 20`, and `mrEvent()` with `state: "running"`.
- The CRLF test uses `mrEvent()`. In "a run continued at risk-check … so an approval starts finish with it", the title ends with "so a person's merge starts finish with it" and the payload is `mrEvent()`.
- Replace "finish for an MR that needs approval and has none does not merge", and delete "a bot approval does not count; a person's approval merges the reviewed commit":
```ts
test("apply never merges a change that waits for a person", async () => {
  const w = await runFinishPipeline(fakeWorld(), { decision: "needs_approval" });
  expect(w.merged).toBe(false);
  expect(w.states).toEqual(["blocked"]);
  expect(w.workItemComments.at(-1)).toContain("waits for a person to merge it");
});
```
- "medium ticket: stops at decision…": add `expect(w.mrComments.at(-1)).toContain("This change needs a person to review and merge it:")`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run factory/adapters/gitlab-tracker.test.ts factory/teams.test.ts factory/steps/flow.test.ts`
Expected: FAIL. The approval still parses as `approved`, the card still says "Needs approval", and the comment still says "approve it".

- [ ] **Step 3: Implement**

- `parseEvent`: return `merged` only for `a?.action === "merge"` on a `factory/<n>-` branch. An approval falls through to `ignored("not-added")`.
- `changeEvent(ctx, e: Extract<FactoryEvent, { kind: "merged" }>)`: start finish with `skipApply: true` always, and keep today's three checks. `run` dispatches on `e.kind === "merged"`. Update the header comment.
- `apply.ts`: replace the approval check with ``if (data(ctx, "decision")?.kind !== "auto") return block(ctx, `Change ${change} waits for a person to merge it, so the factory did not merge it.`);``
- `decision.ts`: `` `This change needs a person to review and merge it:\n\n${…}` ``. `teams.ts`: `needs_approval: "Needs review and merge"`.
- Remove the fake's `approvedByTrusted` option and method, and the world's `approvedBy` option. In the world, `if (p?.kind === "merged") w.openChange();`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test && pnpm typecheck`
Expected: PASS. `grep -rn "approvedBy\|\"approved\"" factory --include='*.ts'` finds only the fixture-driven tracker test.

- [ ] **Step 5: Commit**

```bash
git add factory/seams.ts factory/adapters/gitlab-tracker.ts factory/adapters/gitlab-tracker.test.ts factory/adapters/gitlab-code-host.ts factory/adapters/gitlab-code-host.test.ts factory/gitlab.ts factory/gitlab.test.ts factory/steps/event.ts factory/steps/apply.ts factory/steps/decision.ts factory/teams.ts factory/teams.test.ts factory/fakes.ts factory/steps/test-helpers.ts factory/steps/flow.test.ts
git commit -m "feat(factory): start finish only on a person's merge, never on an approval

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The commit message

**Files:**
- Modify: `prompts/prepare.md`, `prompts/fix.md`
- Modify: `factory/steps/precommit-gate.ts` (`CommitMessage`, `commitMessage`, `changeText`, `run`)
- Modify: `factory/steps/test-helpers.ts` (`WorldOptions.commitFile`, `repo.readFile`)
- Test: `factory/steps/flow.test.ts`

**Interfaces:**
- Consumes: none.
- Produces (all in `factory/steps/precommit-gate.ts`):
  - `export interface CommitMessage { title: string; message: string }`. `message` is the full text without `[AM]`, and `title` is its first line.
  - `export function commitMessage(ctx: StepContext, ticketUrl: string): CommitMessage`
  - `export function changeText(ctx: StepContext, links = …, failed = …, commit: CommitMessage = data(ctx, "precommit-gate")?.commit): { title: string; body: string }`. The new parameter goes last, so `decision.ts` keeps calling `changeText(ctx)` and gets the saved message on a resume.
  - The gate record data gains `commit: CommitMessage`.
  - `WorldOptions.commitFile?: string` is the content of `run/commit-message.md`. Undefined means no file.

The exact closing lines, below the body:
```
Ticket: <ticketUrl>
Factory run <ci.vars.run>: <ci.vars.runUrl>
This was generated by AI in the software factory.
```
`message = [title, body, closing].filter(Boolean).join("\n\n")`.

- [ ] **Step 1: Write the failing tests** (`flow.test.ts`)

```ts
const MSG = "feat(list): show a spinner while the list loads\n\n- Show a spinner in src/List.tsx while the list loads.\n- Cover it in src/List.test.tsx.";
const CLOSING = "Ticket: https://tracker.example/8\nFactory run 1: https://ci.example/runs/1\nThis was generated by AI in the software factory.";
test("the agent's commit message is the branch commit, the MR title and the Commit message section", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, commitFile: MSG }));
  expect(w.commitMessage).toBe(`${MSG}\n\n${CLOSING}`);
  expect(w.mrTitle).toBe("feat(list): show a spinner while the list loads");
  const d = w.mrDescription;
  expect(d).toContain(`## Commit message\n\n${MSG}\n\n${CLOSING}`);
  expect(d.indexOf("Factory run 1:")).toBeLessThan(d.indexOf("## Commit message"));
  expect(d.indexOf("## Commit message")).toBeLessThan(d.indexOf("## Proof"));
  expect(w.record.steps.find((s) => s.step === "precommit-gate")?.data).toMatchObject({
    branch: "factory/8-add-a-loading-state", // the slug keeps the ticket title
    commit: { title: "feat(list): show a spinner while the list loads", message: `${MSG}\n\n${CLOSING}` },
  });
});
test("a missing or bad commit title falls back to the ticket title and keeps the body", async () => {
  const T = "Add a loading state";
  for (const [file, title, body] of [
    [undefined, T, ""],
    ["Added a spinner\n\n- Show a spinner.", T, "- Show a spinner."],
    ["Feat(list): show a spinner", T, ""],
    ["feat(list):show a spinner", T, ""],
    [`feat(list): ${"x".repeat(61)}`, T, ""], // 73 characters
    [`feat(list): ${"x".repeat(60)}`, `feat(list): ${"x".repeat(60)}`, ""], // 72 characters
    ["feat: show a spinner\r\n\r\n- Show it.", "feat: show a spinner", "- Show it."],
    ["refactor(list)!: drop the old loader", "refactor(list)!: drop the old loader", ""],
  ] as const) {
    const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, commitFile: file }));
    expect(w.mrTitle).toBe(title);
    expect(w.commitMessage).toBe([title, body, CLOSING].filter(Boolean).join("\n\n"));
  }
});
test("[AM], [skip ci] and [ci skip] never reach the branch commit or the MR", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, commitFile: "[AM] fix(list): stop the flicker [skip ci]\n\n- Keep the old rows [CI SKIP] until new ones load.\n- [am] Done." }));
  expect(w.mrTitle).toBe("fix(list): stop the flicker");
  for (const t of [w.commitMessage, w.mrDescription]) expect(t).not.toMatch(/\[AM\]|skip ci|ci skip/i);
});
test("a commit message that holds a secret blocks, and nothing is pushed", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, commitFile: "fix(list): stop the flicker\n\n- token=glpat-abcdefghijklmnopqrst1234" }));
  expect(w.states).toEqual(["blocked"]);
  expect(w.commitMessage).toBe("");
  expect(w.mrOpened).toBe(false);
});
test("the author is told to write run/commit-message.md, and to rewrite it after a fix", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { risk: "trivial" }, reviews: [[B], []] }));
  expect(w.claudeRuns[0].prompt).toContain("run/commit-message.md");
  expect(w.claudeRuns.find((j) => j.resume)?.prompt).toContain("run/commit-message.md");
});
```
In the world, `repo.readFile` returns `o.commitFile` for `"run/commit-message.md"`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run factory/steps/flow.test.ts`
Expected: FAIL. The commit is still `Add a loading state (#8)`, and there is no "Commit message" section.

- [ ] **Step 3: Implement**

`commitMessage` works in this order:
1. `text = noSkipCi(ctx.repo.readFile("run/commit-message.md") ?? "").replace(/\[AM\]\s*/gi, "")`.
2. Split on `/\r?\n/`. The title is the first line, trimmed. The body is the rest, joined with `\n` and trimmed.
3. If the title fails the Global Constraints rule or is longer than 72 characters, the title becomes `noSkipCi(ctx.record.ticket!.title)`.
4. Add the closing lines.

`changeText` uses `commit.title` as the title. The body is `[runLine, `## Commit message\n\n${commit.message}`, ...changedTests, proof]`.

In the gate's `run`:
- `const commit = commitMessage(ctx, (await ctx.tracker.ticket(ref)).url)` runs before the first `changeText`, and both `changeText` calls pass `commit`.
- The branch is `` `factory/${ref}-${slug(noSkipCi(ctx.record.ticket!.title))}` ``.
- `commitAndPush(branch, commit.message)`.
- `commit` is saved with the gate data.

Add to `prompts/prepare.md`, after the `run/test-changes.md` line:
```
When the work is done, write the commit message to `run/commit-message.md`.
The first line is a conventional commit title of at most 72 characters: `type(scope): summary`. The type is one of feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert. The scope is optional.
After an empty line, write a bullet list that explains the change in full: what changed, where, why, and which tests cover it. Write one bullet for each part of the change. Do not shorten it to a summary.
Do not write `[AM]`, `[skip ci]` or `[ci skip]`.
```
Add to `prompts/fix.md`:
```
After the fix, rewrite `run/commit-message.md` so it explains the whole change as it is now. Keep its format: a conventional commit title, an empty line, then the full bullet list.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test && pnpm typecheck`
Expected: PASS. This includes the existing "[skip ci] and [ci skip] never reach the commit or MR title…" and "a resume at the decision step changes and uploads nothing".

- [ ] **Step 5: Commit**

```bash
git add prompts/prepare.md prompts/fix.md factory/steps/precommit-gate.ts factory/steps/test-helpers.ts factory/steps/flow.test.ts
git commit -m "feat(change): use the agent's commit message for the branch commit and the change

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Squash merge with `[AM]` after a target check

**Files:**
- Modify: `factory/seams.ts` (`Change.target`, `CodeHost.merge`)
- Modify: `factory/gitlab.ts:165-171` (`merge`), `factory/adapters/gitlab-code-host.ts` (`change`, `merge`)
- Modify: `factory/fakes.ts`, `factory/steps/apply.ts`, `factory/steps/test-helpers.ts`, `factory/contracts/codeHost.contract.ts`
- Test: `factory/gitlab.test.ts`, `factory/adapters/gitlab-code-host.test.ts`, `factory/steps/flow.test.ts`

**Interfaces:**
- Consumes: `CommitMessage` and the gate data `commit` from Task 3. `CodeHost.baseBranch()` from Task 1.
- Produces:
  - `Change.target: string`: the branch the change merges into.
  - `CodeHost.merge(ref: ChangeRef, sha: string, message: string): Promise<string>`: squash merges `sha` with this commit message and returns the commit that landed.
  - `GitLab.merge(projectId: number, mrIid: number, sha: string, message: string): Promise<string>`
  - Fake: `FakeCodeHostOptions.target?: string` (default: the base branch), and `host.mergeMessage: string`.
  - World: `WorldOptions.mrTarget?: string`. Test-helpers: `export const COMMIT: CommitMessage`, which `runFinishPipeline` saves in the precommit-gate data:
    `{ title: "feat(list): show a spinner while the list loads", message: "feat(list): show a spinner while the list loads\n\n- Show a spinner in src/List.tsx.\n\nTicket: https://tracker.example/8\nFactory run 41: https://ci.example/runs/41\nThis was generated by AI in the software factory." }`

- [ ] **Step 1: Write the failing tests**

- `gitlab.test.ts`, the merge test: `gl.merge(1, 2, "head", "[AM] feat(list): x")` and `expect(lastBody()).toEqual({ sha: "head", squash: true, squash_commit_message: "[AM] feat(list): x" })`. The return values (`sq1`, `m1`) stay.
- `gitlab-code-host.test.ts`: the merge test expects the body `{ sha: "head", squash: true, squash_commit_message: "[AM] m" }`. The `change` test sets `target_branch: "develop"` in `mr()` and expects `target: "develop"` in the mapped change.
- `codeHost.contract.ts`: the merge test passes `"[AM] chore: contract"`. New:
```ts
test("a change targets the base branch", async () => {
  const { host, branch, ticket } = await make();
  const { ref } = await host.openChange(branch, "Contract change", "Text.", ticket);
  expect((await host.change(ref)).target).toBe(await host.baseBranch());
});
```
- `flow.test.ts`:
```ts
test("the auto path squash merges the reviewed commit with [AM], the commit message and the MR link", async () => {
  const w = await runFinishPipeline(fakeWorld());
  expect(w.mergedSha).toBe("head5");
  expect(w.host.mergeMessage).toBe(`[AM] ${COMMIT.message}\nMerge request: https://host.example/changes/5`);
});
test("apply does not merge a change that targets another branch than the base branch", async () => {
  const w = await runFinishPipeline(fakeWorld({ mrTarget: "master" }));
  expect(w.merged).toBe(false);
  expect(w.states).toEqual(["blocked"]);
  expect(w.workItemComments.at(-1)).toContain("targets master, not develop");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run factory/gitlab.test.ts factory/adapters/gitlab-code-host.test.ts factory/contracts/codeHost.test.ts factory/steps/flow.test.ts`
Expected: FAIL. There is no `squash` in the body, `target` is undefined, and `mergeMessage` is empty.

- [ ] **Step 3: Implement**

- `GitLab.merge` sends `{ sha, squash: true, squash_commit_message: message }`. Its comment should say that with the fast-forward method, the squash commit is the only commit that lands. Keep the return order `merge_commit_sha ?? squash_commit_sha ?? sha`.
- In the adapter, `change` maps `target: m.target_branch`, and `merge` passes the message through.
- After the Task 2 auto check and the `headSha` check, apply does this:
  - `const base = await ctx.codeHost.baseBranch(); const c = await ctx.codeHost.change(change);`
  - It blocks with `` `Change ${change} targets ${c.target}, not ${base}, so the factory did not merge it.` ``
  - Then it waits for green as today and merges with `` `[AM] ${commit.message}\nMerge request: ${changeUrl}` ``. `commit` and `changeUrl` come from `data(ctx, "precommit-gate")`.
  - A record with no `commit` (one from before this change) throws, and runStep blocks. No fallback.
- Fake: the change objects carry `target: o.target ?? baseBranch`. `merge(ref, sha, message)` stores `host.mergeMessage`. The world passes `target: o.mrTarget`.
- The world wraps `host.merge` to close ticket 8. The wrapper must pass `message` through, and it closes the ticket only after the merge returns: `host.merge = async (ref, sha, message) => { const landed = await merge(ref, sha, message); ticket.open = false; return landed; }`. Otherwise `mergeMessage` stays empty, and a merge that Task 5 refuses would still close the ticket.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add factory/seams.ts factory/gitlab.ts factory/gitlab.test.ts factory/adapters/gitlab-code-host.ts factory/adapters/gitlab-code-host.test.ts factory/fakes.ts factory/steps/apply.ts factory/steps/test-helpers.ts factory/steps/flow.test.ts factory/contracts/codeHost.contract.ts
git commit -m "feat(apply): squash merge with [AM] and check the target branch first

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Rebase before an auto merge

**Files:**
- Modify: `factory/seams.ts` (`Change.behind`, `CodeHost.rebase`, `CodeHost.branchDiff`)
- Modify: `factory/gitlab.ts` (`rebaseMergeRequest`), `factory/adapters/gitlab-code-host.ts` (`change`, `rebase`, `branchDiff`, `sleep` parameter)
- Modify: `factory/fakes.ts`, `factory/steps/apply.ts`, `factory/steps/decision.ts`, `factory/steps/test-helpers.ts`
- Test: `factory/gitlab.test.ts`, `factory/adapters/gitlab-code-host.test.ts`, `factory/steps/flow.test.ts`

**Interfaces:**
- Consumes: the Task 4 apply (target check, squash message) and the Task 1 adapter signature.
- Produces:
  - `Change.behind: boolean`: the source branch is behind the target branch.
  - `CodeHost.rebase(ref: ChangeRef): Promise<{ ok: true; head: string } | { ok: false; error: string }>`: rebases onto the base branch and waits until the rebase ends.
  - `CodeHost.branchDiff(sha: string): Promise<Record<string, string>>`: for each file (keyed by new path), the unified diff of `sha` against the base branch, from their merge base. It throws on a cut-off diff.
  - `GitLab.rebaseMergeRequest(projectId: number, mrIid: number): Promise<void>`: `PUT /projects/:id/merge_requests/:iid/rebase`.
  - `askPerson(ctx: StepContext, reasons: string[]): Promise<StepResult>` in `factory/steps/decision.ts`, exported. It is the decision step's needs-approval tail moved into a function: it reads `change` and `changeUrl` from the `precommit-gate` record data, reads the ticket, sets `needs_approval`, comments `This change needs a person to review and merge it:` plus the reasons as a bullet list on the change, assigns `person(ctx, ticket)`, sends the `needs_approval` card and returns `"stop"`. The decision step calls it instead of its own four lines.
  - `makeGitLabCodeHost(gitlab, projectPath, token, env, baseBranch, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)))`
  - Fake: `export const DIFF = { "src/List.tsx": "@@ -1,2 +1,3 @@\n const a = 1;\n+  if (loading) return <Spinner />;\n" }`. New options: `behind?: number`, `rebaseFails?: boolean`, and `diffs?: Record<string, Record<string, string>>` (by sha; any other sha gets `DIFF`). It exposes `host.rebases: number`. Rebased heads are `` `${head}-r${n}` ``.
  - World: `WorldOptions.behind`, `rebaseFails`, `diffs` pass through to the fake. `mrHead?: string` is the change's head (default `"head5"`).
  - Apply record data: `{ change, sha, reviewed: string, rebased: string[] }`.

How the fake behaves:
- `behind` is how many times `develop` moves ahead of the branch. While any are left, `change().behind` is true and `merge` throws `` `Change ${ref} did not merge: the branch is behind` ``.
- A successful `rebase` uses up one, moves the change's head to the next `-r<n>`, and counts in `rebases`.
- `rebaseFails` returns `{ ok: false, error: "Rebase failed: conflict in src/List.tsx" }`.
- Change `checks` are green only for the change's current head: `changes.get(at.change)?.head ?? head`.

- [ ] **Step 1: Write the failing tests**

`gitlab.test.ts`: `test("rebaseMergeRequest asks GitLab to rebase the MR")`. It calls `gl.rebaseMergeRequest(1, 2)` and expects `last().url` to be `https://gl.example/api/v4/projects/1/merge_requests/2/rebase` and `last().init.method` to be `"PUT"`.

`gitlab-code-host.test.ts`: `host()` now passes a `sleep` spy as its last argument. The spy is `async (ms: number) => void slept.push(ms)`, and `slept` is reset in `beforeEach`. The real 5 s sleep would stall every rebase test.
```ts
// change: the url asks for the diverged count; 0 → behind false, 2 → behind true
expect(calls.at(-1)!.url).toBe("/projects/7/merge_requests/5?include_diverged_commits_count=true");
describe("rebase", () => {
  test("asks GitLab to rebase, waits while it runs, and returns the new head", …);
  // PUT route { rebase_in_progress: true }; the GET returns rebase_in_progress true twice, then { rebase_in_progress: false, sha: "h2", merge_error: null }
  // → { ok: true, head: "h2" }; every poll url is "/projects/7/merge_requests/5?include_rebase_in_progress=true"
  test("a rebase that ends with a merge error fails with that error", …);
  // → { ok: false, error: "Rebase failed: conflict in src/a.ts" }
  test("a rebase GitLab refuses fails, and so does one still running after 60 polls", …);
  // no PUT route → { ok: false, error: matching /status 404/ }
  // always in progress → { ok: false, error: "the rebase did not end within 5 minutes" }, with sleep called 60 times with 5000
});
describe("branchDiff", () => {
  test("returns each file's diff against the base branch from their merge base", …);
  // route "/projects/7/repository/compare" → { diffs: [{ old_path: "src/a.ts", new_path: "src/b.ts", diff: "@@ -1 +1 @@\n-a\n+b\n" }] }
  // → { "src/b.ts": "@@ -1 +1 @@\n-a\n+b\n" }; url "/projects/7/repository/compare?from=develop&to=abc"
  test("a cut-off diff fails instead of reading as no change", …);
  // each of { compare_timeout: true, diffs: [] }, { diffs: [{ new_path: "a", diff: "", too_large: true }] },
  // { diffs: [{ new_path: "a", diff: "", collapsed: true }] } → rejects with /cut off/
});
```
The existing `change` test's `toEqual` gains `behind: false`.

`flow.test.ts`:
```ts
test("a change behind develop is rebased, checked on the rebased head, then merged", async () => {
  const w = fakeWorld({ behind: 1 });
  const seen: string[] = [];
  const checks = w.host.checks;
  w.host.checks = async (at) => (seen.push(at.sha), checks(at));
  await runFinishPipeline(w);
  expect(w.host.rebases).toBe(1);
  expect(w.mergedSha).toBe("head5-r1");
  expect(seen).toEqual(["head5-r1", "manual789"]); // apply checks only the rebased head; verify checks the landed commit
  expect(w.record.steps.find((s) => s.step === "apply")?.data).toMatchObject({ sha: "manual789", reviewed: "head5", rebased: ["head5-r1"] });
});
test("a merge that develop outran is rebased again, then merged", async () => {
  const w = await runFinishPipeline(fakeWorld({ behind: 2 }));
  expect(w.host.rebases).toBe(2);
  expect(w.mergedSha).toBe("head5-r2");
});
test("after 3 rebases when develop keeps moving, a person rebases and merges", async () => {
  const w = await runFinishPipeline(fakeWorld({ behind: 4 }));
  expect(w.host.rebases).toBe(3);
  expect(w.merged).toBe(false);
  expect(w.states).toEqual(["needs_approval"]);
  expect(w.mrComments.at(-1)).toContain("fell behind develop again after 3 rebases");
  expect(w.assigned).toBe(true);
});
test("a failed rebase sends the change to a person to rebase and merge", async () => {
  const w = await runFinishPipeline(fakeWorld({ behind: 1, rebaseFails: true }));
  expect(w.merged).toBe(false);
  expect(w.states).toEqual(["needs_approval"]);
  expect(w.mrComments.at(-1)).toContain("Rebase failed: conflict in src/List.tsx");
  expect(w.mrComments.at(-1)).toContain("Rebase it by hand and merge it");
  expect(w.assigned).toBe(true);
  expect(w.cards.map((c) => c.kind)).toContain("needs_approval");
});
test("a rebased change whose added or removed lines differ from the reviewed one is not merged", async () => {
  for (const diffs of [
    { "head5-r1": { "src/List.tsx": `${DIFF["src/List.tsx"]}+  sendToServer();\n` } },
    { "head5-r1": { ...DIFF, "src/Other.tsx": "@@ -0,0 +1 @@\n+export const x = 1;\n" } },
    { "head5-r1": {} },
  ]) {
    const w = await runFinishPipeline(fakeWorld({ behind: 1, diffs }));
    expect(w.merged).toBe(false);
    expect(w.workItemComments.at(-1)).toContain("is not the change that was reviewed");
  }
});
test("a rebase that only moves the context around the changed lines still merges", async () => {
  const w = await runFinishPipeline(fakeWorld({ behind: 1, diffs: { "head5-r1": { "src/List.tsx": "@@ -9,2 +9,3 @@\n const other = 2;\n+  if (loading) return <Spinner />;\n" } } }));
  expect(w.mergedSha).toBe("head5-r1");
});
test("apply does not merge a branch someone pushed to after the review", async () => {
  const w = await runFinishPipeline(fakeWorld({ mrHead: "pushed1" }));
  expect(w.merged).toBe(false);
  expect(w.workItemComments.at(-1)).toContain("Someone pushed to change 5");
});
test("a merge GitLab refuses for another reason is not retried", async () => {
  const w = fakeWorld();
  w.host.merge = async () => { throw new Error("GitLab PUT /projects/1/merge_requests/5/merge failed with status 405"); };
  await expect(runFinishPipeline(w)).rejects.toThrow("status 405");
  expect(w.host.rebases).toBe(0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run factory/gitlab.test.ts factory/adapters/gitlab-code-host.test.ts factory/steps/flow.test.ts`
Expected: FAIL. `rebase`, `branchDiff` and `rebaseMergeRequest` are not functions, and `behind` is undefined.

- [ ] **Step 3: Implement**

Adapter:
- `change` GETs `` `${mrUrl}?include_diverged_commits_count=true` `` and maps `behind: (m.diverged_commits_count ?? 0) > 0`.
- `rebase`: call `rebaseMergeRequest`. If it throws, return `{ ok: false, error: String(e) }`. Then poll up to 60 times: `sleep(5000)`, then GET `` `${mrUrl}?include_rebase_in_progress=true` ``. Once `rebase_in_progress` is false, return `merge_error ? { ok: false, error: merge_error } : { ok: true, head: m.sha }`. If the polls run out, return `{ ok: false, error: "the rebase did not end within 5 minutes" }`.
- `branchDiff(sha)`: `getJson(`/projects/${id}/repository/compare?from=${encodeURIComponent(baseBranch)}&to=${sha}`)`. Throw ``new Error(`The diff of ${sha} is cut off, so the factory cannot compare it`)`` on `compare_timeout`, `too_large` or `collapsed`. Return `Object.fromEntries(diffs.map((d) => [d.new_path, d.diff]))`.

The apply loop goes after the target check and replaces the single wait-and-merge. Two diffs are the same change when they name the same files, and each file has the same lines that start with `+` or `-`, in the same order. Hunk headers and context lines do not count.
```ts
let head = headSha;
let reviewed: Record<string, string> | undefined;
const rebased: string[] = [];
for (;;) {
  const c = await ctx.codeHost.change(change);
  if (c.head !== head) return block(ctx, `Someone pushed to change ${change} after the review (head ${c.head}, expected ${head}), so the factory did not merge it.`);
  if (c.behind) {
    if (rebased.length === 3) return askPerson(ctx, [`it fell behind ${base} again after 3 rebases. Rebase it by hand and merge it`]);
    reviewed ??= await ctx.codeHost.branchDiff(headSha); // read before the rebase replaces it
    const r = await ctx.codeHost.rebase(change);
    if (!r.ok) return askPerson(ctx, [`the factory could not rebase it onto ${base}: ${r.error}. Rebase it by hand and merge it`]);
    if (!sameChange(reviewed, await ctx.codeHost.branchDiff(r.head))) return block(ctx, `The rebased change ${change} is not the change that was reviewed, so the factory did not merge it.`);
    rebased.push((head = r.head));
  }
  // wait for green on head (today's waitFor and block message)
  try {
    save(ctx, "apply", { change, sha: await ctx.codeHost.merge(change, head, message), reviewed: headSha, rebased });
    break;
  } catch (e) {
    if (!(await ctx.codeHost.change(change)).behind) throw e; // develop moved since the check: rebase again
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test && pnpm typecheck`
Expected: PASS. The contract tests in `factory/contracts/codeHost.test.ts` still pass on the fake.

- [ ] **Step 5: Commit**

```bash
git add factory/seams.ts factory/gitlab.ts factory/gitlab.test.ts factory/adapters/gitlab-code-host.ts factory/adapters/gitlab-code-host.test.ts factory/fakes.ts factory/steps/apply.ts factory/steps/test-helpers.ts factory/steps/flow.test.ts
git commit -m "feat(apply): rebase a change that fell behind develop before the auto merge

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Docs and go-live steps

**Files:**
- Modify: `docs/how-it-works.md`, `docs/add-a-repo.md`, `docs/go-live.md`

**Interfaces:**
- Consumes: the behavior of Tasks 1–5. Use their exact block texts and limits.

- [ ] **Step 1: Edit `docs/how-it-works.md`**

- Intro (line 3): the factory merges a low-risk change into `develop`. Otherwise a person reviews and merges it. Line 9: "A person's review can take days".
- New `## Branches` section before "The ten steps". It holds the four git-flow points of spec section 1. Add one line: the factory works only against the target's `baseBranch` (`develop`) and never reads or writes `master`.
- Step 3: the branch is cut from `develop`, and the author writes `run/commit-message.md` (a conventional title and a full bullet list). Step 7: "Merge without a person, or wait for a person to merge."
- The finish trigger becomes "(starts after an auto decision, or after a person merges the merge request)".
- Step 8: only for an auto decision. Apply checks the target branch and the reviewed head, and rebases through GitLab when the branch is behind `develop` (at most 3 times; the added and removed lines must match the reviewed commit). It then waits for a green pipeline on that commit and squash merges one commit titled `[AM] <conventional title>`. Step 9: the `develop` pipeline.
- Label table: `factory_needs_approval` means "The merge request waits for a person to review and merge it."
- Replace "Approvals and manual merges" with `## Human merges`, with these points:
  - An approval starts nothing.
  - A person reviews, rebases by hand when GitLab asks, and presses Merge. The merge event starts finish with apply skipped. The person must be a Developer or higher and not the bot.
  - Only `factory/` branches count.
  - "It merges the reviewed change, rebased onto `develop` when needed, after a green pipeline on the rebased commit."
  - A failed rebase, or a branch that falls behind again after 3 rebases, goes to `factory_needs_approval` with a comment on the merge request. A person rebases by hand and merges, and that merge runs verify and closes the ticket like any other human merge.
- Line 98: `main` → `develop`.

- [ ] **Step 2: Edit `docs/add-a-repo.md`**

- Line 20: "(or a person merging a factory MR)".
- Line 27: add `baseBranch` (the branch the factory clones, targets and merges into, for example `develop`; required).
- Section 1 gets the GitLab settings of spec section 7, items 1–5, written for any target:
  - Create and protect the base branch.
  - Give the bot merge rights on it, not on `master` (Premium).
  - Set the merge method to "Fast-forward merge" and squash to "Allow", "Encourage" or "Require". The merge method applies to `master` too.
  - Give the base branch no required approval rule for factory MRs.
  - Run a branch pipeline on pushes to the base branch, and a merge request pipeline for MRs into it.

- [ ] **Step 3: Edit `docs/go-live.md`**

- Line 12: Premium means merge rights by name on `develop` and none on `master`. Free means the bot is a Maintainer, and apply's target check is the only guard against a merge into `master`.
- Add the six items of spec section 7 to section 1, for `react_frontend`. Item 6 retargets or closes open factory MRs that target `master` before the new version runs.

- [ ] **Step 4: Verify**

Run: `grep -n "approv\|main branch\|default branch" docs/how-it-works.md`
Expected: only `factory_needs_approval` rows and the merge-rule paragraph. No step says an approval starts anything.

Run: `pnpm test`
Expected: PASS (docs do not affect tests; this confirms nothing else moved).

- [ ] **Step 5: Commit**

```bash
git add docs/how-it-works.md docs/add-a-repo.md docs/go-live.md
git commit -m "docs: describe the develop branch flow and its go-live steps

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
