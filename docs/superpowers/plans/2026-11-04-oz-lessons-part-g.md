# Lessons from oz-for-oss, part G (`@factory` requests) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A trusted person writes a comment with `@factory` on a factory merge request or its work item, and the factory does another round of work on the same merge request, then sends it back to that person.

**Architecture:** A round is a resume. The poller (or a GitLab webhook) finds new requests on a `factory_needs_approval` work item and starts a build pipeline with the run's last build pipeline as `buildRun`, the way a stopped run resumes. That pipeline's event step reads the requests again, runs the injection check, writes a cursor comment, restores the run and continues at prepare-patch. Code review, the gate, the push, the risk check and the decision then run as usual, and the decision always sends the change to the person who asked. The pure rules live in a new `factory/requests.ts`; the step logic in a new `factory/steps/requests.ts`.

**Tech Stack:** TypeScript (ESM, tsx), vitest.

**Spec:** `docs/superpowers/specs/2026-11-03-oz-lessons-design.md` (part G). Part 1 plan: `docs/superpowers/plans/2026-11-03-oz-lessons-part1.md`.

## Global Constraints

- Every write to GitLab or GitHub stays in step scripts. Agents get no new tokens or tools.
- Every new path works through the existing seams (`Tracker`, `CodeHost`, `Judge`), so the GitLab, GitHub and GitHub Projects adapters all get it.
- Text written by people reaches models as data, inside a wrapper, after the injection check.
- Only trusted actors (`Tracker.trusted`: Developer or higher, never the bot) may command the factory. The factory's own comments never count, even when they quote `@factory`.
- Rounds that people ask for have no limit. The agent loops inside each round keep `MAX_AGENT_ROUNDS` (5) from `factory/loops.ts`.
- After a person's request the decision is always `needs_approval`, with the reason `a person asked for changes`. An iteration a person asked for never merges without a person.
- A comment on a merged or closed merge request does nothing.
- Every new branch of logic leaves a test in the existing vitest style.
- `docs/how-it-works.md` and `GLOSSARY.md` are updated in this part.
- Run `pnpm test` and `pnpm typecheck` green before each commit.

## Decisions this plan makes

- Decided by the owner: a comment that has a `@factory stop` or `@factory resume` line is always a command, never a request, even with more text around it. This is stricter than the spec's "not exactly", so a stop can never start work.
- Builder's call: `@factory` counts only as a whole word: `/(^|[^\w@.-])@factory(?![\w-])/i`. `@factory-bot` and `a@factory.dev` are not requests.
- Builder's call: the cursor line is `Requests read up to: <ISO time>`, in a factory comment on the work item or on the merge request. Only the factory's own comments are read for it. With no cursor line yet (a change sent to a person before this part shipped), the cursor is the time of the factory's newest comment on the merge request. With neither, nothing is read.
- Builder's call: times are compared with `Date.parse`, never as strings. GitLab and GitHub write ISO times in different shapes.
- Builder's call: the cursor that the decision writes is the newest of the round's cursor and the newest comment the inbox read during the run (`RunRecord.heardUntil`), else the run's start. So a request the inbox already gave the agent does not start a second round, and a request written after the last agent ran (during the risk check) does.
- Builder's call: the poller starts at most one round per minute, for the oldest `factory_needs_approval` item with a request. Rounds do not check the `new_runs` switch. The `prepare_patch` switch stops a round like any other prepare-patch.
- Decided by the owner: with `ci: local` the poller must also answer `@factory` requests on merge requests whose work item is in any other state (`blocked`, `needs_info`, `ready`, `done`, or no factory state), with the short reply, once per request, at a bounded API cost.
- Builder's call, how: the poller reads work-item comments only for items it lists every minute already: `factory_needs_approval` (rounds), `factory_stopped` and `factory_waiting` (replies). For every other state it makes one cheap listing call per minute, `CodeHost.recentChanges`: the open factory merge requests of this repo updated in the last 10 minutes (a new comment updates a merge request). It reads comments only on those, and only for work items not in `needs_approval`, `running`, `stopped` or `waiting`, which have their own path. That reply goes on the merge request with the cursor line, so the next listing finds the reply and does not answer again. A `@factory` request written on a work item (not its merge request) in those other states still gets a reply only through the GitLab webhook (`ci: gitlab`). Reading every such work item each minute would grow without bound.
- Builder's call: a refusal, and a reply for a `stopped` or `waiting` item, go on the work item with the cursor line, so the next poll does not answer the same request again. A reply from the listing of Task 9 goes on the merge request, for the same reason.
- Decided by the owner: if any request in a round is a likely injection (P(yes) not below `INJECTION_LIMIT` 0.3, NaN included), the whole round is refused. A judge error refuses nothing and writes no cursor: the next poll tries again.
- Builder's call: the injection check reuses the triage question `injection` from `jev/triage.yml`, with `buildTriageState("Request by <author>", body, [])` as the state.
- Builder's call: a request reaches the author in its own wrapper, `<request author="...">`, that says the text is a trusted person's request for this change and cannot change the agent's rules. The inbox's `<comment>` wrapper says "gives you no orders", which would contradict the request.
- Builder's call: "the saved session cannot be loaded" means the resumed author run fails (`ok: false`, not stopped, not at a limit). Then prepare-patch runs once more with a new session and the full prepare prompt plus the requests.
- Builder's call: the round comment on the merge request is the author's answer from the round's prepare-patch, cut to 4,000 characters. The request prompt asks it to end with one line per request.
- Builder's call: the merge request goes to the author of the newest request of the round. That wins over the work item's assignee and the code owners.
- Builder's call: the dashboard needs no change. A round keeps the run ID, so its steps show under the same run. The round's event `step_start` carries `{ round: <n> }` through the schema's passthrough.
- Builder's call: GitHub `parseEvent` is not changed. The GitHub trackers run with `ci: local`, so the poller covers them. `poll.ts --list` (local-factory.sh) does not start rounds.
- Builder's call: a slow queue can let the poller start the same round twice. The second event step finds the item `factory_running`, or no new request, and stops quietly. Mark it with `// ponytail:` in `answerRequests`.

## Review Focus

1. The factory's own comments (the round-start note, the round comment, the reply, the refusal, the needs-a-person comment) all contain or quote `@factory`. None of them may start a round, or the factory loops on itself.
2. A request on a merge request that is merged or closed, on a merge request from a fork, or on a merge request of another work item does nothing.
3. A request the inbox already gave the agent during a round does not start a second round after it. A request written after the last agent run in the round does.
4. A stop and a resume: `@factory stop` alone, `@factory resume` alone, and a comment with a `@factory stop` line plus other text never start a round. A round resumed after a stop does not see the old stop again.
5. The judge is down or returns NaN: no round starts, the item stays `factory_needs_approval`, and a judge error does not move the cursor.
6. A request on the merge request of a `blocked`, `needs_info`, `ready`, `done` or unlabeled work item: one reply on the merge request, never a second one on the next poll, never a round, and never a reply when the request is on a merged or closed merge request or by an untrusted person.

Each line has its test in the owning task: 1 and 2 in Task 4, 3 in Tasks 3 and 8, 4 in Tasks 2 and 3, 5 in Task 5, 6 in Task 9.

---

### Task 1: Read merge request comments (seam)

**Files:**
- Modify: `factory/seams.ts` (`CodeHost`), `factory/adapters/gitlab-code-host.ts`, `factory/adapters/github-code-host.ts`, `factory/fakes.ts`
- Test: `factory/adapters/gitlab-code-host.test.ts`, `factory/adapters/github-code-host.test.ts`

**Interfaces:**
- Produces:
  - `CodeHost.changeComments(ref: ChangeRef, since?: string): Promise<Comment[]>`: comments by people and the factory on the change, newest first, only those created after `since`. System notes are left out. `byFactory` is true for the factory's own comments.
  - `fakeCodeHost` gains `sayOnChange(ref: ChangeRef, author: PersonRef, body: string, at?: string, byFactory = false): void`, and `commentChange` also records the factory's comment there with `byFactory: true`.

- [ ] **Step 1: Write the failing tests**

GitLab: `changeComments("5", "2026-11-04T10:00:00Z")` calls `GET /projects/<id>/merge_requests/5/notes?sort=desc&order_by=created_at&per_page=100` (the tracker's `comments` call, for a merge request), drops `system` notes and notes not after `since`, and sets `byFactory` for the `/user` name. GitHub: `GET /repos/<r>/issues/5/comments?per_page=100&since=...`, keeps only comments created after `since`, newest first; `byFactory` only when the author is the token's user and the body starts with `AI_LINE` (the code host has no `sharedAccount`, so it always asks for both).

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run factory/adapters/gitlab-code-host.test.ts factory/adapters/github-code-host.test.ts`
Expected: FAIL, `changeComments` is not a function.

- [ ] **Step 3: Implement in both adapters and the fake**

The GitLab code host caches the bot name from `GET /user`, as the tracker does.

- [ ] **Step 4: Run the suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add factory/seams.ts factory/adapters/gitlab-code-host.ts factory/adapters/gitlab-code-host.test.ts factory/adapters/github-code-host.ts factory/adapters/github-code-host.test.ts factory/fakes.ts
git commit -m "feat(seams): read the comments on a change"
```

### Task 2: Request rules and the round record

**Files:**
- Create: `factory/requests.ts`, `factory/requests.test.ts`
- Modify: `factory/record.ts`, `factory/agents.ts`, `factory/triage.ts`
- Test: `factory/requests.test.ts`, `factory/agents.test.ts`

**Interfaces:**
- Produces, in `factory/requests.ts`:
  - `export function isRequest(body: string): boolean`
  - `export const cursorLine = (at: string) => \`Requests read up to: ${at}\``
  - `export function readCursor(comments: Comment[]): string | undefined`: the cursor of the newest factory comment that has the line. Comments by people are ignored.
  - `export const later = (a: string | undefined, b: string | undefined): string | undefined`: the later of two ISO times by `Date.parse`; the other one when one is undefined.
  - `export function stateReply(author: PersonRef, state: FactoryState | undefined): string`: one short comment that says what the state allows. Text per state: `stopped` "Comment `@factory resume` to continue the run. A request then reaches the agent while it works."; `waiting` "The run waits for the author agent's usage limit. The factory continues it within the hour."; `blocked` "Add factory_ready to continue the run."; `needs_info` "Answer the factory's questions, then add factory_ready."; `done` "This work is done. Open a new work item for more."; anything else "The factory has not started work here. Add factory_ready to start." Each starts with `@<author> The factory takes @factory requests only while its change waits for a person (factory_needs_approval).`
- Produces, in `factory/record.ts`:
  - `export interface Request { author: PersonRef; body: string; at: string; on: "work item" | "change" }`
  - `export interface RequestRound { cursor: string; requests: Request[]; costAtStart: number; tokensAtStart: { input: number; output: number }; answer?: string; endedAt?: string; review?: number; gate?: number; costUsd?: number; tokens?: { input: number; output: number } }`
  - `RunRecord.requestRounds?: RequestRound[]` and `RunRecord.heardUntil?: string`
  - `StepData.event.round?: number` (the round's number, from 1)
  - `runFacts` gains `roundStart: boolean` (the newest event started a round), `openRound: RequestRound | undefined` (the last round with no `endedAt`), and `requested: boolean` (the record has a round).
- Produces, in `factory/agents.ts`: `export function wrapRequest(author: PersonRef, body: string): string`. It breaks `</request>` in the body like the inbox does for `</comment>`.
- Produces, in `factory/triage.ts`: `export const injectionQuestion: JevQuestion` (the `injection` entry of `questions`).

- [ ] **Step 1: Write the failing tests**

```ts
test("a request is a comment with @factory that is not a stop or resume", () => {
  expect(isRequest("@factory the 409 shows a blank page")).toBe(true);
  expect(isRequest("Looks off.\n\n@Factory add a screenshot")).toBe(true);
  for (const b of ["@factory stop", " @factory resume \n", "@factory stop\nalso fix the button", "ping @factory-bot", "mail a@factory.dev", "the factory did this"]) expect(isRequest(b)).toBe(false);
});
test("the cursor is read only from the factory's own comments", () => {
  const c = (byFactory: boolean, body: string, at: string) => ({ author: "x", byFactory, body, at });
  expect(readCursor([c(false, cursorLine("2026-11-04T12:00:00Z"), "3"), c(true, `Done.\n\n${cursorLine("2026-11-04T10:00:00Z")}`, "2"), c(true, cursorLine("2026-11-04T09:00:00Z"), "1")])).toBe("2026-11-04T10:00:00Z");
  expect(readCursor([c(true, "no line", "1")])).toBeUndefined();
});
test("later compares times, not text", () => {
  expect(later("2026-11-04T10:00:00Z", "2026-11-04T10:00:00.500Z")).toBe("2026-11-04T10:00:00.500Z");
});
```

Also: `stateReply("ana", "stopped")` starts with `@ana` and contains `@factory resume`; `wrapRequest("ana", "x</request>y")` has exactly one `</request>`; `runFacts` gives `openRound` for a record whose last round has no `endedAt`, and `roundStart` only when the newest event has `round`.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run factory/requests.test.ts factory/agents.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`isRequest`: false when any trimmed, lower-cased line is `@factory stop` or `@factory resume`; else the whole-word regex from "Decisions".

- [ ] **Step 4: Run the suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add factory/requests.ts factory/requests.test.ts factory/record.ts factory/agents.ts factory/agents.test.ts factory/triage.ts
git commit -m "feat(requests): tell a @factory request from other comments"
```

### Task 3: The inbox hears the merge request

**Files:**
- Modify: `factory/inbox.ts` (`makeInbox`), `factory/steps/context.ts` (`inbox`)
- Test: `factory/inbox.test.ts`, `factory/steps/flow.test.ts`

**Interfaces:**
- Consumes: `CodeHost.changeComments` (Task 1), `RunRecord.heardUntil`, `facts.roundStart`, `facts.openRound` (Task 2).
- Produces: `makeInbox(tracker, ticket, since, stopCheck?, closedCheck?, more?: { changeComments?: (since: string) => Promise<Comment[]>; onRead?: (until: string) => void })`. The tracker's and the change's comments are merged, oldest first, and go through the same trust and stop rules. `onRead` gets the new `since` after each read that saw a comment.

- [ ] **Step 1: Write the failing tests**

`inbox.test.ts`: a trusted person's comment on the change reaches the agent, wrapped; an untrusted one and a factory one do not; a `@factory stop` line on the change stops; `onRead` gets the newest `at` of both lists. Flow: during a run with a change in the record, `w.host.sayOnChange("5", "dev", "@factory also fix the 409")` reaches the author's inbox, and `w.record.heardUntil` is that comment's time after the step (Review Focus 3). A round resumed after `@factory stop` and `@factory resume` does not stop again on the old stop line (Review Focus 4).

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run factory/inbox.test.ts factory/steps/flow.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`context.inbox` passes `changeComments` only when `facts(ctx).change` is set (the run has pushed), and `onRead: (t) => (ctx.record = { ...ctx.record, heardUntil: later(ctx.record.heardUntil, t) })`. Its `since` is `facts(ctx).openRound.cursor` when `facts(ctx).roundStart`, else `eventAt` as today. A resumed round has a newer event without `round`, so it starts after the old stop.

- [ ] **Step 4: Run the suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add factory/inbox.ts factory/inbox.test.ts factory/steps/context.ts factory/steps/flow.test.ts
git commit -m "feat(inbox): read the change's comments too"
```

### Task 4: Find requests and answer them (poller)

**Files:**
- Create: `factory/steps/requests.ts`, `factory/steps/requests.test.ts`
- Modify: `factory/steps/poll.ts` (`main`)

**Interfaces:**
- Consumes: Tasks 1 and 2, `CodeHost.changeOfTicket`, `buildRunOf` from `factory/steps/merge.ts`.
- Produces, in `factory/steps/requests.ts`:
  - `export async function newRequests(ctx: StepContext, ref: TicketRef): Promise<{ requests: Request[]; change?: { ref: ChangeRef; url: string } }>`: the requests after the cursor, oldest first, by trusted people who are not the factory, from the work item and, only when `changeOfTicket(ref)` is open, from that change.
  - `export async function answerRequests(ctx: StepContext, t: Ticket): Promise<"started" | "replied" | "none">`: with new requests, a `factory_needs_approval` ticket starts a build with `buildRun` from the change body (`ci.start({ kind: "build", ticket, buildRun })`); a `factory_running` ticket does nothing (the inbox has it); any other state gets one work-item comment, `stateReply` for each distinct author, then `cursorLine` of the newest request.
  - `export async function pollRequests(ctx: StepContext, skip: TicketRef[] = []): Promise<TicketRef[]>`: `answerRequests` for the `needs_approval` tickets, oldest first, until one round starts; then for the `stopped` and `waiting` tickets. Each ticket in its own try/catch, like `pollReady`. Returns the tickets it started.

- [ ] **Step 1: Write the failing tests**

`requests.test.ts`, each its own test, on a world with ticket 8 in `factory_needs_approval` and its open change 5 whose body has `Factory run 41: ...` and a factory comment with `cursorLine(T0)`:
- a trusted `@factory add a screenshot` on change 5 after T0 starts one build with `{ kind: "build", ticket: "8", buildRun: "41" }`; the same on the work item does too;
- a request before T0, a plain comment, an untrusted person's request, and a factory comment that quotes `@factory` start nothing and post nothing (Review Focus 1);
- a request on change 5 after it merged, or after it was closed, does nothing; a request on another work item's change does not count for ticket 8 (Review Focus 2);
- two `needs_approval` tickets with requests: one poll starts only the older one;
- a `factory_stopped` ticket with a request gets one comment with `@factory resume` and the cursor line; the next poll posts nothing;
- a `factory_running` ticket with a request gets nothing;
- no cursor line: the cursor is the factory's newest comment on the change; with no factory comment at all, nothing is read.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run factory/steps/requests.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement and wire**

`newRequests` reads all comments of both (no `since`), takes the cursor from `readCursor` of both lists, and caches `trusted` per author like the inbox. `poll.ts` `main` calls `pollRequests(ctx, handled)` after `handleRequests` and logs `Started request rounds for tickets: ...` like the other lines. Not in `--list`.

- [ ] **Step 4: Run the suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add factory/steps/requests.ts factory/steps/requests.test.ts factory/steps/poll.ts
git commit -m "feat(poll): hear @factory requests on changes that wait for a person"
```

### Task 5: The event step starts a round

**Files:**
- Modify: `factory/steps/requests.ts`, `factory/steps/event.ts` (`run`), `factory/steps/run.ts` (export `continueAt`)
- Test: `factory/steps/requests.test.ts`, `factory/steps/flow.test.ts`

**Interfaces:**
- Consumes: Tasks 2 and 4, `continueAt`, `ctx.judge`, `injectionQuestion`, `INJECTION_LIMIT`.
- Produces:
  - `continueAt(ctx, ref, resumeAt, d: { actor?: string; fromPipeline: string; sessionId?: string; round?: number })`, now exported. With `round` it saves `round` in the event data and sends `step_start` with `{ round }`.
  - `export async function requestRound(ctx: StepContext, ref: TicketRef, buildRun: string): Promise<StepResult>` in `factory/steps/requests.ts`.

- [ ] **Step 1: Write the failing tests**

Flow, with a first build run to `factory_needs_approval` through `runBuildJobs`, a request on the change, then a second build with `vars: { ticket: "8", buildRun: "41" }`:
- the round restores run 41, posts on the work item `The factory started another round for the requests of @dev.` with the cursor line of the newest request, removes the marks `implemented`, `reviewed`, `checked`, `risk_checked`, resets `rounds` to `{ review: 0, gate: 0 }`, sets `factory_running`, appends a `RequestRound` with the request text, and continues at prepare-patch with the saved session;
- the ticket is no longer `factory_needs_approval`, or there is no new request, or change 5 is no longer open: the step stops quietly and changes nothing;
- `jev1: { injectionYes: 0.9 }`: a refusal comment that names the author, with the cursor line; the state stays `factory_needs_approval`; nothing is restored (Review Focus 5);
- the judge returns NaN: the same refusal; the judge throws: no comment, no cursor, the state stays `factory_needs_approval`, and the step ends with `start: false, reason: "judge-error"` (Review Focus 5);
- the dashboard gets no `run_start`: the round keeps the run ID.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run factory/steps/requests.test.ts factory/steps/flow.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement and wire**

`event.ts`: when there is no payload and both `ticket` and `buildRun` are set, a ticket in `needs_approval` goes to `requestRound`, every other state to `resume` as today. `requestRound` order: state check; `facts.cannotContinue`; `changeOfTicket` must be open and equal `facts.change`; `newRequests`; the injection check of each request (refusal text: `@<authors> The factory did not act on this request: the judge found it may try to give an AI agent orders. A person must read it. The change still waits for a person.`); then `restoreRun`, the round-start comment, the unmarks, the record update (`costAtStart` and `tokensAtStart` from the record), and `continueAt(ctx, ref, "prepare-patch", { fromPipeline: buildRun, sessionId: facts(ctx).session, round: n })`. No slot check: the item holds its slot already. Add the `// ponytail:` note on double starts here.

- [ ] **Step 4: Run the suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add factory/steps/requests.ts factory/steps/requests.test.ts factory/steps/event.ts factory/steps/run.ts factory/steps/flow.test.ts
git commit -m "feat(run): start a round of work for a person's @factory request"
```

### Task 6: GitLab webhook hears requests

**Files:**
- Modify: `factory/seams.ts` (`FactoryEvent`), `factory/adapters/gitlab-tracker.ts` (`parseEvent`), `factory/steps/event.ts`
- Test: `factory/adapters/gitlab-tracker.test.ts`, `factory/steps/flow.test.ts`

**Interfaces:**
- Consumes: `isRequest` (Task 2), `answerRequests` (Task 4).
- Produces: `FactoryEvent` gains `{ kind: "request"; ticket: TicketRef; actor: PersonRef; change?: ChangeRef }`.

- [ ] **Step 1: Write the failing tests**

`gitlab-tracker.test.ts`: a `note` on an `Issue` that `isRequest` gives `{ kind: "request", ticket, actor }`; a `note` on a `MergeRequest` whose `merge_request.source_branch` is `factory/8-x` and whose source and target project ids are equal gives `{ kind: "request", ticket: "8", actor, change: "<iid>" }`; a fork's merge request, a non-factory branch, a system note and a plain comment are ignored; `@factory stop` still gives the `command` event. Flow: a `request` event by the bot or an untrusted person stops quietly; on a `factory_needs_approval` item it starts the round build; on a `factory_blocked` item it posts the reply; with a `change` that is not the ticket's open change it does nothing.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run factory/adapters/gitlab-tracker.test.ts factory/steps/flow.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`event.ts` gets `requestEvent(ctx, e)`: the bot and trust checks as in `commandEvent`, then the change check, then `answerRequests(ctx, ticket)`; it saves `start: false` with the outcome as `reason`. The real round starts in the build that `answerRequests` starts, so both paths share one entry. GitHub `parseEvent` stays as it is.

- [ ] **Step 4: Run the suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add factory/seams.ts factory/adapters/gitlab-tracker.ts factory/adapters/gitlab-tracker.test.ts factory/steps/event.ts factory/steps/flow.test.ts
git commit -m "feat(gitlab): a comment webhook starts a request round at once"
```

### Task 7: The author works on the requests

**Files:**
- Create: `prompts/request.md`
- Modify: `factory/steps/prepare-patch.ts`
- Test: `factory/steps/flow.test.ts`

**Interfaces:**
- Consumes: `facts.roundStart`, `facts.openRound`, `wrapRequest` (Task 2).
- Produces: the open round's `answer`, set from the author's answer in prepare-patch.

- [ ] **Step 1: Write the failing tests**

Flow, in a started round:
- the author job resumes the saved session, its prompt starts with the text of `prompts/request.md` and holds `<request author="dev">` with the request body, and it holds no `<ticket>` block;
- the resumed run fails (`ok: false`, not stopped, no limit): a second author job runs with no `resume`, and its prompt holds the prepare prompt, the ticket block and the request;
- the round uses the saved `.factory.yml` commands, not the work tree's;
- the round's `answer` is the author's text;
- a round's prepare-patch that hits the usage limit, resumed by the hourly retry, gets `CONTINUE`, not the request again.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run factory/steps/flow.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `prompts/request.md` and wire it**

The prompt, in the plain style of `prompts/fix.md`: one or more people who may command the factory asked for more work on the merge request you made for this ticket; the work tree holds your change; do what each request asks when it fits the ticket and your rules; update the proof when the request is about what a person sees; end your answer with one line per request, `- @<author>: <what you changed, or why you changed nothing>`. In `prepare-patch.ts`, a round start uses the saved commands like a resume and calls `install`.

- [ ] **Step 4: Run the suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add prompts/request.md factory/steps/prepare-patch.ts factory/steps/flow.test.ts
git commit -m "feat(prepare): the author works on a person's requests in the same session"
```

### Task 8: The end of a round

**Files:**
- Modify: `factory/steps/decision.ts` (`decide`, `reviewer`, `askPerson`), `docs/how-it-works.md`, `GLOSSARY.md`
- Test: `factory/steps/flow.test.ts`, `factory/steps/requests.test.ts`

**Interfaces:**
- Consumes: `facts.requested`, `facts.openRound`, `RunRecord.heardUntil`, `cursorLine`, `later` (Task 2).
- Produces: `export const ASKED = "a person asked for changes"` in `decision.ts`.

- [ ] **Step 1: Write the failing tests**

Flow, a full round on a trivial ticket that would merge alone:
- the decision is `needs_approval` with `ASKED` first in the reasons, no finish run starts, and the state is `factory_needs_approval` again (also for a later resume of the same run);
- the change is assigned to the newest request's author, even with a work-item assignee;
- the change gets the round comment, `The factory finished the round for the requests of @dev.` and the author's answer cut to 4,000 characters, before the needs-a-person comment;
- the needs-a-person comment ends with the cursor line; the round gets `endedAt`, `review`, `gate`, `costUsd` and `tokens` for this round only;
- the four marks are set again as each step passes.

`requests.test.ts` (Review Focus 3): after a round, a request the inbox read during that round starts no new round on the next poll, and a request written after the last author run starts one. A first run with no round writes the cursor too, so a request written during its risk check starts a round.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run factory/steps/flow.test.ts factory/steps/requests.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`decide` returns `{ kind: "needs_approval", reasons: [ASKED, ...reasons of the normal decision] }` when `facts.requested`. `reviewer` returns the newest request's author of the last round first. `askPerson` posts the round comment when there is an open round, closes the round in the record, and adds `cursorLine(later(ctx.record.heardUntil, facts.openRound?.cursor) ?? facts.eventAt)` to its comment.

- [ ] **Step 4: Update the docs**

`docs/how-it-works.md`: a new section `## Requests on a merge request`, after "Stop and resume", that says who may ask, what counts as a request, the cursor, what each state does, the injection check, how a round runs, that it always goes back to the person who asked, and that the poller is the main path with `ci: local`. Add one line about requests to "The poller and retry". `GLOSSARY.md`, under Control: **Request**: a trusted person's comment with `@factory` on a factory merge request or its work item that asks for more work (_Avoid_: command, mention); **Round**: one more pass of work on the same run and merge request, from prepare-patch to the decision, for the requests since the last round (_Avoid_: iteration, rerun).

- [ ] **Step 5: Run the suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add factory/steps/decision.ts factory/steps/flow.test.ts factory/steps/requests.test.ts docs/how-it-works.md GLOSSARY.md
git commit -m "feat(decision): a round goes back to the person who asked"
```

### Task 9: Replies on merge requests in every other state

**Files:**
- Modify: `factory/seams.ts` (`CodeHost`), `factory/adapters/gitlab-code-host.ts`, `factory/adapters/github-code-host.ts`, `factory/fakes.ts`, `factory/steps/requests.ts`, `factory/steps/poll.ts` (`main`), `docs/how-it-works.md`
- Test: `factory/adapters/gitlab-code-host.test.ts`, `factory/adapters/github-code-host.test.ts`, `factory/steps/requests.test.ts`, `factory/steps/poll.test.ts`

**Interfaces:**
- Consumes: `changeComments` (Task 1), `isRequest`, `readCursor`, `cursorLine`, `later`, `stateReply` (Task 2), the trust cache of `newRequests` (Task 4).
- Produces:
  - `CodeHost.recentChanges(since: string): Promise<{ ref: ChangeRef; ticket: TicketRef }[]>`: the open changes of this repo whose branch starts with `factory/<n>-` and that were updated after `since`, newest first, at most 100, from one listing call. Forks are left out, as in `changeOfTicket`.
  - `export const REPLY_WINDOW_MS = 10 * 60_000` and `export async function replyOnChanges(ctx: StepContext): Promise<TicketRef[]>` in `factory/steps/requests.ts`: the tickets it replied to.

- [ ] **Step 1: Write the failing tests**

Adapters: GitLab `recentChanges(T)` makes one call, `GET /projects/<id>/merge_requests?state=opened&updated_after=<T>&order_by=updated_at&sort=desc&per_page=100`, and keeps `factory/12-x` from the same project as `{ ref, ticket: "12" }`; a fork and `feature/x` are dropped. GitHub makes one call, `GET /repos/<r>/pulls?state=open&sort=updated&direction=desc&per_page=100`, keeps those with `updated_at` after `T` and `head.repo.full_name` equal to the repo, same filter.

`requests.test.ts`, each its own test (Review Focus 6):
- ticket 8 `factory_blocked`, its open change 5 with a trusted `@factory fix the 409` in the window: one comment on change 5 that starts with `@dev`, says to add factory_ready, and ends with `cursorLine` of the request's time; no build starts;
- the same for `needs_info`, `ready`, `done` and no state, each with its own sentence from `stateReply`;
- the next call replies to nothing: the reply's cursor line is newer than the request;
- a second request after the reply gets its own reply;
- an untrusted author, a factory comment that quotes `@factory`, `@factory stop`, and a plain comment get no reply;
- a ticket in `needs_approval`, `running`, `stopped` or `waiting` is skipped here (the other paths own it), so no request ever gets two replies;
- `recentChanges` is called once per call, with `since` 10 minutes before now, and `changeComments` only for the changes it returns.

`poll.test.ts`: `main` calls `replyOnChanges` once per tick after `pollRequests` and logs `Replied to requests on changes of tickets: ...`; an error in it is logged and the tick goes on.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm vitest run factory/adapters/gitlab-code-host.test.ts factory/adapters/github-code-host.test.ts factory/steps/requests.test.ts factory/steps/poll.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`replyOnChanges`: `recentChanges(now - REPLY_WINDOW_MS)`; for each change, `changeComments(ref, since)`; the cursor is `readCursor` of those comments; the requests are the comments after it, not by the factory, `isRequest`, by a trusted author. With any, read the ticket; skip the four states above; else `commentChange(ref, stateReply for each distinct author, then cursorLine(newest request))`. Each change in its own try/catch. Put this note on it: `// ponytail: one listing call and at most 100 changes a minute; a request older than 10 minutes when the poller was down gets no reply. Widen REPLY_WINDOW_MS or page further if that bites.` `fakeCodeHost.recentChanges` answers from its changes map with an `updatedAt` that `sayOnChange` sets.

- [ ] **Step 4: Update the docs**

In `docs/how-it-works.md`, in the section from Task 8, say that the poller also answers a request on the merge request of a work item in any other state with one short reply, from a listing of the merge requests updated in the last 10 minutes, and that a request on such a work item itself is answered only by the GitLab webhook.

- [ ] **Step 5: Run the suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add factory/seams.ts factory/adapters/gitlab-code-host.ts factory/adapters/gitlab-code-host.test.ts factory/adapters/github-code-host.ts factory/adapters/github-code-host.test.ts factory/fakes.ts factory/steps/requests.ts factory/steps/requests.test.ts factory/steps/poll.ts factory/steps/poll.test.ts docs/how-it-works.md
git commit -m "feat(poll): answer @factory requests on changes in every other state"
```
