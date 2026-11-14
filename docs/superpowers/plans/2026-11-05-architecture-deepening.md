# Architecture deepening plan

Date: 2026-11-05. Source: the architecture review of the same date (six candidates). Related findings live in `docs/reviews/2026-11-05-factory-dashboard-review.md`; IDs such as D-P4 refer to that file.

Spec: none written for this refactor. The binding authorities are `GLOSSARY.md`, the decisions in `docs/adr/`, the specs in `docs/superpowers/specs/`, and the existing tests. Behaviour that tests assert stays the same unless a task says it fixes a named bug.

## Global constraints

- Use `GLOSSARY.md` words in new names: work item (not ticket), run, step, round, request, stop, resume, restart, paused run, event. Do not rename existing `ticket` fields outside the task's scope.
- Do not add dependencies.
- Keep the data-ownership decision: the dashboard never stores a work item's state; the tracker owns it.
- Tests: `pnpm test` and `pnpm typecheck` at the repo root cover `factory/`. For the dashboard run `pnpm --filter dashboard test` and `pnpm --filter dashboard typecheck`. Run both before each commit (`pnpm precommit` covers the root).
- Each task ends with one or more commits in Conventional Commits style (see `the team's git workflow doc` and recent `git log`). End each commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Delete code the new module replaces. Do not leave the old path beside the new one.
- Tests go through the new module's interface. Delete tests that only tested the deleted shallow modules once the new tests cover the same behaviour.

## Task 1: One run view module in the dashboard

Files: `dashboard/src/server/db.ts` (`request`, `state`, `runs`), `dashboard/src/app/api/runs/[run]/[action]/route.ts`, the run state GET route the run controls read, `dashboard/src/components/run-controls.tsx`, `dashboard/src/components/run-timeline.tsx` (`PAUSED`, `over`, stuck logic), `dashboard/src/app/api/board/route.ts`, `dashboard/src/components/stuck.ts`.

Problem: five modules each work out a run's state. `db.request()` never checks the state for a stop, so it accepts a stop on `needs_approval` (D-P4). The board route calls `isStuck` with only `!endedAt`, so it shows Stuck on stopped and other paused runs (D-P5). "Is this run stopped" has two rules: newest `label_change` versus last `step_end.outcome === "stopped"`.

Change:
- Add a pure module, for example `dashboard/src/server/run-view.ts`, with one function that takes a run's events and control requests (and the stuck limits and `now` when needed) and returns at least: current state, `ended`, `paused`, `stuck`, last step, the allowed `actions` (subset of stop, resume, restart), and a refusal reason per refused action.
- The rules it encodes are the union of what exists today: the button rule in `run-controls.tsx:74`, every refusal in `db.request()` (already requested, ended, already restarted, not the newest run, cancelled means restart only, not stopped), plus the fix for D-P4: stop is allowed only while the state is `running`. Paused states are the existing `PAUSED` list.
- `db.request()` asks the run view and refuses with its reason. The state route returns the view's actions; `RunControls` renders those actions instead of computing them. The board route and the timeline use the view's `stuck`, which is false for paused and ended runs (fixes D-P5).
- Delete `stuck.ts`, `PAUSED` in the timeline, and the duplicated rules once nothing uses them.
- Tests: table tests on the run view (events in, view out) covering running, stopped, cancelled, restarted, needs_approval, blocked, newer run exists, ended, stuck and not stuck. Route and db tests keep only the mapping of a refusal to the HTTP status already used. Add one regression test each for D-P4 and D-P5 at the interface where the bug showed.
- Commit as `refactor(dashboard): ...` plus `fix(dashboard): ...` for the two bugs if separate commits read better.

## Task 2: One work item conversation module in the factory

Files: `factory/requests.ts`, `factory/steps/run.ts` (note writers and readers, about lines 60-152), `factory/steps/requests.ts`, `factory/steps/triage.ts`, `factory/dedupe.ts`, `factory/inbox.ts`, `factory/improve/evidence.ts`, the fingerprint marker in `factory/adapters/gitlab-tracker.ts` and `factory/adapters/github-tracker.ts`.

Problem: work item comments hold the factory's paused state and cursors. Each note's writer and its regex reader sit in different modules: `cursorLine`/`readCursor`, `readyForLine`/`readyForOf`, `stoppedNote`/`parseStoppedNote`, `waitingNote`/`WAITING_RUN`, `DEDUPE_MARKER`, the fingerprint marker. The rule "a trusted comment, not by the factory, with `@factory`, after the cursor" is written five times, each with its own trust cache (`steps/requests.ts` twice, `steps/triage.ts`, `inbox.ts`, `improve/evidence.ts`). The inbox skips the injection check that `steps/requests.ts` applies (F-P2). `evidence.ts` treats any `DEDUPE_MARKER` as a duplicate close, but triage also puts it on the duplicate question (F-P3).

Change:
- Add one module, for example `factory/conversation.ts`, that sits on top of the Tracker and CodeHost seams. Its interface lets callers (a) list a work item's or change's requests since a point, already trust-checked and injection-checked, with one shared trust cache per run, and (b) write a factory note of a named kind and read the newest note of a kind. Kinds cover what exists today: blocked, waiting, stopped, cancelled, cursor, readyFor, duplicate question, duplicate close, fingerprint if it fits cleanly.
- Every current writer and reader of those notes and every copy of the request rule goes through the module. Callers stop knowing note text formats, the by-factory rule, or trust caching.
- Fix F-P2: inbox comments get the same injection check as requests.
- Fix F-P3: the duplicate question and the duplicate close get different note kinds; `reopened_duplicate` evidence counts only the close. Existing comments already posted with the old marker must still read correctly as far as today's code reads them; keep the old text readable if the format changes.
- Note text that people see on the tracker must not change unless needed for F-P3.
- Tests: write a note through a fake tracker, read it back, per kind; one test per request rule (a person's copy of a factory note is ignored, newest wins, untrusted author dropped, injection flagged, factory's own comments skipped, cursor respected). Remove flow tests that only checked comment text the new tests now cover. Regression tests for F-P2 and F-P3.

## Task 3: A fake CI adapter that keeps run records

Files: `factory/fakes.ts` (`fakeCi`), `factory/steps/test-helpers.ts` (`runBuildPipeline`, `runFinishPipeline`, and friends), `factory/steps/flow.test.ts`, read-only context `factory/steps/run.ts` (`continuePoint`, `startStopped`, poller handlers) and `factory/steps/context.ts` (`runStep`, `saveRecord`).

Problem: `fakeCi.buildRecord` only serves a fixed records map and `start()` only pushes to an array. No test goes through the real loop: a build saves its run record, a stop comes in, the poller starts a new pipeline, and that pipeline loads the record and resumes. Tests stub `w.ci.buildRecord` and `w.ci.vars` about 46 times and hand-build records (`runFinishPipeline`).

Change:
- Make `fakeCi` keep the run records the steps save, keyed the way the real CI adapters key them, and serve them back from `buildRecord`.
- Make `start()` queue a pipeline with its vars, and add a way for a test to run the queued pipelines through the real step runner with the matching step list (build or finish), for example `drain()` on the fake world or a helper in test-helpers.
- Replace stubs in `flow.test.ts` with the real path where the stub only faked what the fake now does. Keep a stub only where a test needs a record the factory cannot produce (for example a corrupt record).
- Add end-to-end tests for: stop during build then resume; stop then restart; waiting at the author usage limit then resume; a finish pipeline that loads the build's record without a hand-built record.
- Do not change production code unless a test exposes a real bug; if it does, fix it in its own commit with a regression test and say so in the report.

## Task 4: One withStep module owns step start and step end

Files: `factory/steps/context.ts` (`runStep`, `fix`, `watch`, around lines 146-300), `factory/steps/run.ts` (`startRun` around line 70, `continueAt` around line 302), the event step, `factory/steps/test-helpers.ts`.

Problem: `step_start` and `step_end` events are sent from five places (`runStep`, `startRun`, `continueAt`, `fix`, the event step) with special cases, and `fix` swaps `ctx.step` and `ctx.stepEvent` and restores them by hand. Because of that the only safe test surface is the whole pipeline: 195 of 230 flow tests run it.

Change:
- Add one function in the factory steps code, for example `withStep(ctx, name, fn)`, that sends `step_start`, runs `fn`, sends `step_end` with the outcome, sets and restores the step fields on the context and the parent event id, and handles a throw. The event step's special case becomes an option.
- `runStep`, `fix`, `startRun`, `continueAt` and the event step use it. No other code sends `step_start` or `step_end`.
- The events the dashboard receives keep the same types, fields and order for every path the flow tests cover; the dashboard must not need a change. If an existing order was inconsistent between paths, keep it and note it.
- Tests: direct tests of `withStep` (start and end sent, outcome on end, context restored after a nested step and after a throw, parent id set). Where flow tests only checked step event pairing, move that check to these tests.

## Task 5: Cut factory/gitlab.ts down to transport

Files: `factory/gitlab.ts`, `factory/gitlab.test.ts`, `factory/adapters/gitlab-tracker.ts`, `factory/adapters/gitlab-code-host.ts`, `factory/adapters/github-tracker.ts`, `factory/adapters/github-code-host.ts`, `factory/contracts/codeHost.contract.ts`, `factory/fakes.ts`, `factory/compose.ts`, and any other importer of `gitlab.ts` (find them with `graft callers` or grep).

Problem: the `GitLab` class has about 24 methods; about 18 have one non-test caller and `botUserId` and `openMergeRequest` have none. The adapters already call `getJson`/`call` directly for many endpoints, so GitLab endpoint knowledge is split between two modules with no rule. The label rule is split too (`STATE_LABELS` in gitlab.ts; `labelOf`, `STATE_ORDER`, `ENDED` in the adapter). Host-neutral helpers `AI_LINE` and `noQuickActions` live in gitlab.ts and the GitHub adapters import them (F-S2).

Change:
- Keep the `GitLab` class as transport: request, paging, retries, error handling, and the secret refusal on posted text if it lives there today (move it to a small shared helper both GitLab adapters use if that reads better).
- Move each endpoint method into the one adapter that uses it. Delete methods with no non-test caller.
- Put the state label rule in the GitLab tracker adapter.
- Move `AI_LINE`, `noQuickActions` and any other host-neutral helper to a neutral module; GitHub code and contracts import from there and no longer import `gitlab.ts`.
- Tests: `gitlab.test.ts` keeps only transport tests (retry, paging, errors). Endpoint tests move to the adapter tests or contract tests. Behaviour seen through the Tracker and CodeHost seams does not change.

## Task 6: Typed event data in run-events

Files: `factory/run-events.ts`, its importers in `factory/` and `dashboard/src/` (about 15 dashboard files, for example `dashboard/src/server/db.ts`, `dashboard/src/components/run-timeline.tsx`, `dashboard/src/components/step-detail.tsx`).

Problem: `run-events.ts` owns the event shapes but `EVENT_DATA` is typed `Record<EventType, z.ZodTypeAny>`, so every reader casts (`e.data.outcome as string`, `Record<string, any>`). `STEPS` is an untyped `string[]`. `label_change` sends the tracker label `factory_<state>` and the dashboard strips the prefix back (`db.ts` `state`).

Change:
- Make `EVENT_DATA` a const object of zod schemas so TypeScript keeps each schema's type; export `EventData<T>` and a typed event union discriminated on `type`. Make `STEPS` and any state list `as const` with derived union types.
- Replace casts on event data in factory and dashboard readers with the typed access, where the event type is known. Keep casts only where data comes from untyped storage and add one parse there instead if cheap.
- `label_change` sends the state without the `factory_` prefix. The dashboard keeps reading old stored rows that hold the prefix, in one place.
- Tests: mostly the typecheck. Add one dashboard test that an old `factory_*` row and a new row both read as the same state.
