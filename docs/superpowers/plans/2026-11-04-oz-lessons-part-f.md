# Lessons from oz-for-oss, part F (dedupe) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before the factory builds a work item that a person wrote, check it against the other open work items. Close a plain duplicate with a comment, and ask on a near duplicate.

**Architecture:** One new read on the `Tracker` seam (`listOpen`) gives the candidates in all three tracker modes. A small module `factory/duplicate-check.ts` asks the judge and decides, like `factory/triage.ts` does. The triage step calls it after the injection check passes and before the clarity outcome acts. The step does every write. The writer (no tools, one turn) drafts the question text.

**Tech Stack:** TypeScript (ESM, tsx), vitest.

**Spec:** `docs/superpowers/specs/2026-11-03-oz-lessons-design.md` (part F).

## Global Constraints

- Every write to GitLab or GitHub stays in step scripts. Agents get no new tokens or tools.
- Every new path works through the existing seams, so the GitLab, GitHub and GitHub Projects adapters all get it.
- Text written by people reaches models as data, inside a wrapper, after the injection check.
- Every new branch of logic leaves a test in the existing vitest style.
- `docs/how-it-works.md` and `GLOSSARY.md` are updated with each part.
- Candidates: the open work items of the same target project, at most the newest 200, the work item itself left out.
- `same` closes only with confidence 0.9 or more. `same` below 0.9 counts as `adds`.
- Watcher and dispatch work items skip the check.
- Run `pnpm test` and `pnpm typecheck` green before each commit.

## Decisions this plan makes

- Builder's call: candidates for the judge. Each candidate goes in as its ref, its title and the first 300 characters of its body. 200 candidates are about 100,000 characters, which fits one judge call, so there is no title search first. If a judge cannot take that much, cut the 300 down; do not add a search.
- Builder's call: the judge cannot write free text, so the writer drafts the question that names what the new work item adds. The writer runs only when the judge's injection answer for the candidates is under `INJECTION_LIMIT` (0.3). The candidates did not pass the triage injection check, and the closest one goes into the writer's prompt. When the writer is skipped, fails, or its text does not name `#<original>`, the factory posts a fixed question.
- Builder's call: how triage knows "the person decided". Every dedupe comment ends with the hidden line `<!-- factory:dedupe -->`. A work item with a factory comment that holds it skips the check. That covers both cases in the spec: `factory_ready` added again after a question, and a reopened work item the factory closed. No new label, no new seam.
- Builder's call: watcher and dispatch work items both carry the `watcher` mark. That mark is the skip test.
- Builder's call: `listOpen` reads the repo's open issues through REST in all GitHub modes. In Projects mode the board column is not read; dedupe needs only the text.
- Builder's call: the judge's choice options are ordered `different`, `adds`, `same`. The Jev mock picks the first option, so a factory with no `BERGET_API_KEY` never closes or questions anything.
- Builder's call: a failed dedupe read or judge call blocks the run, like a failed triage call. The factory does not guess.
- Builder's call: a closed duplicate ends the run with the existing outcome `closed`. No new outcome, no new switch.

## Review Focus

1. The mock judge, or a judge that answers `same` with confidence 0.89 or `NaN`: the factory never closes the work item. It asks.
2. A person adds `factory_ready` again after a dedupe question or reopens a closed duplicate: no second dedupe comment, the run goes on to the clarity outcome.
3. Text in another open work item that tries to give the writer orders: the writer never sees it; the fixed question goes out.
4. A project where the work item is the only open one: no judge call, the run goes on as today.
5. A project with more than 200 open work items: the judge sees exactly the newest 200, the work item itself left out.

Each line has its test: 1 and 5 in Task 2, 1 to 4 in Task 3.

---

### Task 1: `Tracker.listOpen`

**Files:**
- Modify: `factory/seams.ts` (`Tracker`), `factory/adapters/gitlab-tracker.ts`, `factory/adapters/github-tracker.ts`, `factory/fakes.ts` (`fakeTracker`)
- Test: `factory/adapters/gitlab-tracker.test.ts`, `factory/adapters/github-tracker.test.ts`

**Interfaces:**
- Produces: `listOpen(limit: number): Promise<Ticket[]>` on `Tracker`. Open work items of the project, any labels, newest first, at most `limit`. Comment on the seam: "every open work item, newest first; the state is not read on a board".

- [ ] **Step 1: Write the failing adapter tests**

GitLab, in the style of the `listClosed` test:

```ts
test("listOpen reads open tickets newest first, page by page, up to the limit", async () => {
  routes["/projects/7/issues"] = { body: Array.from({ length: 100 }, (_, i) => issue({ iid: 300 - i })) };
  const l = await tracker().listOpen(150);
  expect(l).toHaveLength(150);
  expect(calls.filter((c) => c.method === "GET" && c.url.includes("state=opened&order_by=created_at&sort=desc&per_page=100"))).toHaveLength(2);
  expect(calls.some((c) => c.method !== "GET")).toBe(false);
});
```

GitHub, labels mode and board mode (same request in both): `listOpen(150)` reads `state=open&sort=created&direction=desc&per_page=100&page=1` and `page=2`, drops pull requests, returns at most 150, and stops after a page with fewer than 100 items. Use the file's existing fetch fake and names.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run factory/adapters/gitlab-tracker.test.ts factory/adapters/github-tracker.test.ts`
Expected: FAIL, `listOpen is not a function`.

- [ ] **Step 3: Implement `listOpen` in both adapters and the fake**

GitLab: loop `page` from 1 with the `issues()` helper and `state=opened&order_by=created_at&sort=desc&per_page=100&page=<n>`; stop at `limit` or a short page. GitHub: the same loop with `gh.json("GET", …)`, `fromRest`, the `!i.pull_request` filter and `toTicket(i)` with no board state; do not use `gh.all`, it reads every page. Fake: `[...tickets.values()].filter((t) => t.open).reverse().slice(0, limit)`.

- [ ] **Step 4: Run the suite**

Run: `pnpm test && pnpm typecheck`
Expected: PASS. Any other `Tracker` object literal in tests that fails the type check gets `listOpen: async () => []`.

- [ ] **Step 5: Commit**

```bash
git add factory/seams.ts factory/adapters/gitlab-tracker.ts factory/adapters/github-tracker.ts factory/fakes.ts factory/adapters/*.test.ts
git commit -m "feat(tracker): listOpen reads the newest open work items"
```

### Task 2: The dedupe judge (`factory/duplicate-check.ts`)

**Files:**
- Create: `factory/duplicate-check.ts`
- Test: `factory/duplicate-check.test.ts`

**Interfaces:**
- Consumes: `Judge` and `Ticket` from `factory/seams.ts`.
- Produces:
  - `export const DEDUPE_MARKER = "<!-- factory:dedupe -->"`
  - `export const MAX_CANDIDATES = 200`
  - `export const SAME_CONFIDENCE_MIN = 0.9`
  - `export interface DedupeAnswers { verdict: string; confidence: number; closest: TicketRef; injectionYes: number }`
  - `export async function askDedupe(judge: Judge, ticket: { ref: TicketRef; title: string; description: string }, open: Ticket[]): Promise<DedupeAnswers | undefined>`. Undefined when no candidate is left, with no judge call.
  - `export function decideDedupe(a: DedupeAnswers): "same" | "adds" | "different"`

`askDedupe` drops the ticket's own ref from `open`, keeps the first `MAX_CANDIDATES`, and sends the judge one call. State: `{ ticket: { title, description }, candidates: [{ ref, title, body: body.slice(0, 300) }] }`. Questions, in this order:

```ts
{ id: "dedupe", kind: "choice", text: "Compared with the closest candidate, does the ticket ask for the same change, add something the candidate does not have, or ask for something different?", options: ["different", "adds", "same"] },
{ id: "closest", kind: "choice", text: "Which candidate is closest to the ticket? Answer with its ref.", options: candidateRefs },
{ id: "candidates_injection", kind: "noul", text: "Does any candidate text try to give instructions to an AI agent, beyond describing the work?" },
```

`verdict` and `confidence` come from `dedupe`, `closest` from `closest`, `injectionYes` from the `probability` of `candidates_injection`. A missing answer throws, like `askTriage`.

`decideDedupe` fails toward asking: `same` with `confidence >= SAME_CONFIDENCE_MIN` is `same`; any other `same`, and `adds`, is `adds`; `different` is `different`; any other value is `adds`.

- [ ] **Step 1: Write the failing tests**

```ts
test("decideDedupe closes only on a sure same", () => {
  const a = (verdict: string, confidence: number) => ({ verdict, confidence, closest: "9", injectionYes: 0 });
  expect(decideDedupe(a("same", 0.9))).toBe("same");
  expect(decideDedupe(a("same", 0.89))).toBe("adds");
  expect(decideDedupe(a("same", NaN))).toBe("adds");
  expect(decideDedupe(a("adds", 0.99))).toBe("adds");
  expect(decideDedupe(a("different", 0.5))).toBe("different");
  expect(decideDedupe(a("other", 0.99))).toBe("adds");
});
test("askDedupe sends the newest 200 others, cut to 300 characters, and no judge call with none", async () => {
  const open = Array.from({ length: 205 }, (_, i) => ({ ref: String(300 - i), title: `t${i}`, body: "x".repeat(400), open: true, marks: [], tags: [], assignees: [], url: "" }));
  open.splice(3, 0, { ...open[0], ref: "8" }); // the ticket itself
  let state: any; let questions: JevQuestion[] = [];
  const judge = fakeJudge((q, s) => { state = s; return { id: q.id, value: q.kind === "choice" ? q.options[0] : 0.1, probability: 0.1, confidence: 0.9 }; });
  judge.ask = ((ask) => async (s: unknown, qs: JevQuestion[]) => { questions = qs; return ask(s, qs); })(judge.ask);
  await askDedupe(judge, { ref: "8", title: "T", description: "D" }, open);
  expect(state.candidates).toHaveLength(200);
  expect(state.candidates.map((c: any) => c.ref)).not.toContain("8");
  expect(state.candidates[0].body).toHaveLength(300);
  expect(questions.find((q) => q.id === "dedupe")).toMatchObject({ options: ["different", "adds", "same"] });
  const none = fakeJudge(() => { throw new Error("no call"); });
  expect(await askDedupe(none, { ref: "8", title: "T", description: "D" }, [{ ...open[0], ref: "8" }])).toBeUndefined();
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run factory/duplicate-check.test.ts`
Expected: FAIL, cannot find module `./dedupe`.

- [ ] **Step 3: Implement `factory/duplicate-check.ts`**

Follow the shape of `askTriage` and `decideTriage` in `factory/triage.ts`. Keep the questions as a constant in the file; no new YAML file.

- [ ] **Step 4: Run them and see them pass**

Run: `pnpm vitest run factory/duplicate-check.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add factory/duplicate-check.ts factory/duplicate-check.test.ts
git commit -m "feat(dedupe): judge a work item against the open ones"
```

### Task 3: Dedupe in triage, with docs

**Files:**
- Create: `prompts/dedupe-question.md`
- Modify: `factory/steps/triage.ts`, `factory/steps/test-helpers.ts` (`WorldOptions`, `fakeWorld`), `docs/how-it-works.md` (step 2 "Triage", and the `factory_needs_info` row of the labels table), `GLOSSARY.md`
- Test: `factory/steps/flow.test.ts`

**Interfaces:**
- Consumes: `Tracker.listOpen` (Task 1); `askDedupe`, `decideDedupe`, `DEDUPE_MARKER`, `MAX_CANDIDATES` (Task 2); `INJECTION_LIMIT` from `factory/triage.ts`; `agent`, `ticketText`, `prompt`, `notify` from `./context`; `wrapTicket` from `../agents`; `localPath`, `localSection`; `block`, `endRun` from `./run`.
- Produces: `async function dedupe(ctx: StepContext, ticket: Ticket): Promise<StepResult | undefined>` inside `factory/steps/triage.ts`. Undefined means "go on".
- Test helper options: `dedupe?: { verdict?: "same" | "adds" | "different"; confidence?: number; closest?: string; injectionYes?: number } | "throw"` (default `different`, confidence 0.95, closest `"9"`, injectionYes 0.05) and `writerText?: string` (default `"Does this belong in #9, or is it a separate change? This one also asks for a spinner."`). `fakeWorld` exposes `dedupeAsked: number` (judge calls that held the `dedupe` question).

`run` in `factory/steps/triage.ts` calls `dedupe` right after `save(ctx, "triage", …)` and before the `Triage:` comment, only when `outcome.kind !== "blocked"`. A defined result is returned.

`dedupe` does, in order:

1. Skip (undefined) when `ticket.marks` holds `watcher`, or a comment from `ctx.tracker.comments(ref)` with `byFactory` holds `DEDUPE_MARKER`.
2. `askDedupe(ctx.judge, { ref, ...ctx.record.ticket }, await ctx.tracker.listOpen(MAX_CANDIDATES + 1))`. A throw from the read or the judge: `block(ctx, \`The duplicate check failed, so the factory did not guess: ${String(e)}\`)`. Undefined answers or `different`: return undefined.
3. Find the original in the list by `closest`.
4. `same`: comment, then `clearState`, then `close`, then `endRun(ctx, "closed")`, return `"stop"`. Text:
   `This work item asks for the same change as #<ref> (<url>), so the factory closed it as a duplicate. If it is a separate change, reopen it, say what is different, and add factory_ready again.\n\n<!-- factory:dedupe -->`
5. `adds`: the question text, then `comment(ref, \`${text}\n\n${DEDUPE_MARKER}\`)`, `setState(ref, "needs_info")`, `endRun(ctx, "needs_info")`, `notify(ctx, "needs_info", ["The factory asked whether the work item repeats another one."], "")`, return `"stop"`.

The question text: when `injectionYes < INJECTION_LIMIT`, run `agent(ctx, "writer", ctx.router.writer, { tools: "none", maxTurns: 1, cwd: ctx.dir, prompt })` with prompt `${prompt("dedupe-question")}${localSection(await ctx.codeHost.readFile(localPath("writer")))}\n\n${ticketText(ctx)}\n\n${wrapTicket(\`#${o.ref} ${o.title}\n\n${o.body.slice(0, 8000)}\`)}`. Use `r.text.trim()` when `r.ok` and it contains `#<ref>`. Otherwise use the fixed text:
`This work item looks close to #<ref> (<url>). Does it belong in #<ref>, or is it a separate change? If it is separate, say what it adds, then add factory_ready again.`

`prompts/dedupe-question.md` (exact copy is the builder's; it must say these): the first ticket is new, the second is an open one that looks close. Write one short comment to the person who wrote the new ticket. Name the open one as `#<ref>`. Say in one sentence what the new ticket adds. Ask whether it belongs in that one or is a separate change. Plain text, at most 3 sentences, no headings. Reply with the comment only.

- [ ] **Step 1: Extend `fakeWorld`**

The fake judge answers `dedupe`, `closest` and `candidates_injection` from `o.dedupe`, and throws on `"throw"`; it counts `dedupeAsked`. The fake harness answers `job.role === "writer"` with `o.writerText`.

- [ ] **Step 2: Write the failing flow tests**

Ticket 9 "Another ticket" is the open candidate in `fakeWorld`.

```ts
// Part F: dedupe for work items written by people.
test("a sure duplicate is closed with a link and never built", async () => {
  const w = await runBuildPipeline(fakeWorld({ dedupe: { verdict: "same", confidence: 0.95 } }));
  expect(w.closed).toBe(true);
  expect(w.tracker.cleared).toContain("8");
  expect(w.workItemComments.at(-1)).toMatch(/same change as #9 .*https:\/\/tracker\.example\/9/s);
  expect(w.workItemComments.at(-1)).toContain("<!-- factory:dedupe -->");
  expect(w.cloned).toEqual([]);
  expect(w.tracker.tickets.get("8")!.marks).not.toContain("triaged");
});
test("an unsure same asks instead of closing", async () => {
  const w = await runBuildPipeline(fakeWorld({ dedupe: { verdict: "same", confidence: 0.89 } }));
  expect(w.closed).toBe(false);
  expect(w.states).toEqual(["needs_info"]);
});
test("a work item that adds something gets the writer's question and needs_info, before the clarity questions", async () => {
  const w = await runBuildPipeline(fakeWorld({ jev1: { clarity: 4 }, dedupe: { verdict: "adds" } }));
  expect(w.states).toEqual(["needs_info"]);
  expect(w.workItemComments.at(-1)).toContain("Does this belong in #9");
  expect(w.workItemComments.at(-1)).toContain("<!-- factory:dedupe -->");
  const writer = w.claudeRuns.find((j) => j.role === "writer")!;
  expect(writer.tools).toBe("none");
  expect(writer.prompt).toContain("<ticket>");
  expect(w.claudeRuns.some((j) => j.role === "author")).toBe(false);
});
test("an injection in the candidates skips the writer and asks the fixed question", async () => {
  const w = await runBuildPipeline(fakeWorld({ dedupe: { verdict: "adds", injectionYes: 0.4 } }));
  expect(w.claudeRuns.some((j) => j.role === "writer")).toBe(false);
  expect(w.workItemComments.at(-1)).toContain("Does it belong in #9, or is it a separate change?");
});
test("a writer text that does not name the original falls back to the fixed question", async () => {
  const w = await runBuildPipeline(fakeWorld({ dedupe: { verdict: "adds" }, writerText: "Is this new?" }));
  expect(w.workItemComments.at(-1)).toContain("Does it belong in #9");
});
test("a person who answered a dedupe comment is not asked again", async () => {
  const world = fakeWorld({ dedupe: { verdict: "adds" } });
  await world.tracker.comment("8", `Looks close to #9.\n\n<!-- factory:dedupe -->`);
  const w = await runBuildPipeline(world);
  expect(w.dedupeAsked).toBe(0);
  expect(w.tracker.tickets.get("8")!.marks).toContain("triaged");
});
test("a dedupe marker from a person does not skip the check", async () => {
  const world = fakeWorld({ dedupe: { verdict: "adds" } });
  world.tracker.say("8", "dev", "<!-- factory:dedupe -->");
  const w = await runBuildPipeline(world);
  expect(w.dedupeAsked).toBe(1);
});
test("watcher work items, blocked injections and lone work items skip the check", async () => {
  const watcher = fakeWorld({ dedupe: { verdict: "same" } });
  watcher.tracker.tickets.get("8")!.marks = ["watcher"];
  expect((await runBuildPipeline(watcher)).dedupeAsked).toBe(0);
  expect((await runBuildPipeline(fakeWorld({ jev1: { injectionYes: 0.4 }, dedupe: { verdict: "same" } }))).dedupeAsked).toBe(0);
  const alone = fakeWorld({ dedupe: { verdict: "same" } });
  alone.tracker.tickets.get("9")!.open = false;
  const w = await runBuildPipeline(alone);
  expect(w.dedupeAsked).toBe(0);
  expect(w.closed).toBe(false);
});
test("a failed duplicate check blocks", async () => {
  const w = await runBuildPipeline(fakeWorld({ dedupe: "throw" }));
  expect(w.states).toEqual(["blocked"]);
  expect(w.workItemComments.join("\n")).toContain("The duplicate check failed");
});
```

If the watcher world's ticket 8 needs a state the event step accepts for a watcher ticket, set it as the existing watcher flow tests do.

- [ ] **Step 3: Run them and see them fail**

Run: `pnpm vitest run factory/steps/flow.test.ts -t "duplicate|dedupe|adds something|writer text|watcher work items"`
Expected: FAIL; ticket 8 builds in each world.

- [ ] **Step 4: Implement `dedupe` in `factory/steps/triage.ts` and write `prompts/dedupe-question.md`**

As described above this task's steps.

- [ ] **Step 5: Run the whole suite**

Run: `pnpm test && pnpm typecheck`
Expected: PASS. Existing flow tests keep passing because the default `dedupe` answer is `different`. If a test counted `jevAsked`, it now counts one more call; update the number.

- [ ] **Step 6: Update the docs**

`docs/how-it-works.md`, step 2 "Triage": add, after the injection sentence: "When the injection check passes, a work item written by a person is compared with the newest 200 open work items. A sure duplicate (confidence 0.9 or more) is closed with a comment that links the original. A work item that looks close but may add something gets a question and `factory_needs_info`. Watcher and dispatch work items skip this. A work item with an earlier dedupe comment from the factory skips it too: the person decided." In the labels table, the `factory_needs_info` row also names the dedupe question.

`GLOSSARY.md`, under "## Work":

```md
**Duplicate check**:
The triage check that compares a work item a person wrote with the open work items. It closes a sure duplicate and asks on a near one. It runs once per work item.
_Avoid_: Dedup, similarity check
```

- [ ] **Step 7: Commit**

```bash
git add factory/steps/triage.ts factory/steps/test-helpers.ts factory/steps/flow.test.ts prompts/dedupe-question.md docs/how-it-works.md GLOSSARY.md
git commit -m "feat(triage): close or question a work item that repeats an open one"
```
