# Code review: factory and dashboard (2026-11-05)

Whole-codebase review of `factory/` and `dashboard/src/` at `890315f`, on two axes:
Standards (repo docs plus the Fowler smell baseline) and Spec (the specs under
`docs/superpowers/specs/`, plans and ADRs). Four read-only reviewers, nothing was run.
Findings are unverified reports: confirm each one in the code before fixing it.

The repo has no coding-standards doc, so the Standards axis uses `GLOSSARY.md`,
`seams.yml`, `dashboard/DESIGN.md`, the ADRs, `docs/how-it-works.md`, the installed
Vercel React skills and the smell baseline. "Hard" = breaks a written repo rule;
smells are judgement calls.

Status column for fixes: open / fixed / wontfix. All start open.

## Standards

### Factory

- **F-S1 (hard, GLOSSARY)** "ticket" and "dedupe" used instead of "work item" and "duplicate check". `seams.ts:10` `TicketRef`/`Ticket`/`Tracker.ticket()`, `gitlab.ts:68` `createWorkItem`, `dedupe.ts`, `DEDUPE_MARKER`, `askDedupe`, `steps/triage.ts:90`. Also `retryRestart`/`retry-waiting` where the term is Resume, and `MENTION` in `requests.ts` where the term is Request. Fix: start with `dedupe` → `duplicate-check` and `Ticket` → `WorkItem` in `seams.ts`.
- **F-S2 (hard, seams.yml)** GitHub adapters and a contract import GitLab modules. `adapters/github-tracker.ts:3`, `adapters/github-code-host.ts:2`, `contracts/codeHost.contract.ts:2`, `fakes.ts:1` import `AI_LINE`/`noQuickActions` from `../gitlab`; `adapters/local-ci.ts:9`, `worker.ts:14` import `checkVars`/`secretFile` from `adapters/gitlab-ci`. Fix: move them to a neutral module.
- **F-S3 (hazard)** Provider keys go on the `docker create` command line. `worker.ts:77,207,209`: `stepEnv` copies `providerKeys(seams)` into env and `runStep` turns each into `-e K=V`; visible in `ps` and `docker inspect`. The file header says values never go on a command line. Fix: pass them as secret files.
- **F-S4 (hazard)** Unhandled rejection in the worker. `worker.ts:~296` `dispatch` = `lock(...).then(() => true)` with no `.catch`, called with `void`; a throw kills the worker on Node 22. `tickTarget` in the main loop has no try/catch, so one bad target stops all polling. Fix: `.catch(log)` and wrap each target tick.
- **F-S5 (hazard, how-it-works "times are compared as times")** Timestamps compared as text. `adapters/gitlab-tracker.ts:~95` `n.created_at > since`, `adapters/github-tracker.ts:~188` `c.created_at > since`. `…:00Z` vs `…:00.000Z` sorts wrong. Fix: `Date.parse`.
- **F-S6 (hazard)** `jev.ts:80` falls back to fixed answers with only a `console.warn` when `BERGET_API_KEY` is missing; triage then fails open. Fix: throw outside tests or require `FACTORY_JEV_MOCK=1`.
- **F-S7 (hazard)** Errors swallowed or matched by string. `adapters/github-tracker.ts:~186` `trusted()` `.catch(() => undefined)` treats 5xx as untrusted, no log; `steps/precommit-gate.ts:41` `.catch(() => "")`; `/status 404|No ticket/` twice in `steps/run.ts`, `includes("failed with status 404")` in `gitlab.ts`, `github-code-host.ts`, `github-tracker.ts`. Fix: throw an `HttpError {status}` from the API clients.
- **F-S8 (Duplicated Code)** Jev answer lookup (`decision.ts`, `triage.ts`, `dedupe.ts`, `watcher/run.ts`); `maxAgentRounds` read + clamp (`steps/code-review.ts`, `steps/precommit-gate.ts`); shell quoting (`claude-code.ts`, `pi.ts`, `repo.ts`); trust cache (`inbox.ts`, `steps/triage.ts`, `steps/requests.ts`); unique authors ×4; `botName` ×4; `sleep` default ×6; AI_LINE body in both code hosts; `String(e).slice(0, 300)` ×15; two rebase polling loops; `@factory stop|resume` literals in 4 places. Fix: one helper per shape.
- **F-S9 (Shotgun Surgery)** A new state touches `FactoryState` (`run-events.ts:9`), `STATE_LABELS` (`gitlab.ts:4`), `STATE_ORDER`/`ENDED` (both trackers), `ACTIVE_STATES`/`PAUSED` (`run.ts`), `WHAT` (`requests.ts`). Marks and step names likewise; `STEPS` is an untyped `string[]`. Fix: derive from one `as const` array.
- **F-S10 (Divergent Change)** `steps/run.ts` (480 lines) mixes start rules, note parsing, closed-run detection and poller handlers; `steps/merge.ts` exports text helpers other steps use; `context.ts` mixes context, controls, inbox, `agent`, `fix`, `runStep`, `watch`. Fix: split `pause-notes.ts`, `poller.ts`, `change-text.ts`.
- **F-S11 (Data Clumps)** `(exec, base)` through `runShort`, `runImprove`, `runOne` (9 params), `tickTarget`, `hetznerHost`; `makeInbox` has 6 positional params; boolean flag on `block(ctx, reason, continuable)`. Fix: a `Worker` object and an options object.
- **F-S12 (Speculative Generality / Refused Bequest)** `loops.ts` `LoopDeps` forces callers to pass throwing or empty stubs. Test-only exports in production (`ADAPTER_NAMES`, `makeTracker`/`makeCodeHost`), and `fakes.ts`, `steps/test-helpers.ts`, `adapters/test-zip.ts` beside production code. Fix: two narrow dep types.
- **F-S13 (Mysterious Name)** Three different `need` functions; `agentEnv` in both harnesses with different signatures; comments cite "Ruling R45/R47" (`run.ts:438,455`), "Spec 6.5" (`event.ts:11`), "Part G", "Task 5" with no target; orphan revert comment in `github-code-host.ts`.
- **F-S14 (other)** `as Risk` casts on Jev answers; `triage_outcome.kind` is a string; `emit.ts:runIds` digs into step data that `runFacts` exposes; `watch()` replaces `ctx.tracker`/`ctx.judge` with `Object.create` proxies; hard-coded `GITLAB_URL` (`gitlab.ts:5`); `improve/` and `watcher/` import `prompt` from `steps/context`, `record.ts` imports a type from `steps/precommit-gate`.

### Dashboard

- **D-S1 (hard, hazard, `lib/api.ts` rule)** `components/run-timeline.tsx:26` and `components/step-detail.tsx:117` use bare `fetch`, not `api()`. On session expiry the run page errors every second and never redirects to sign-in. Fix: use `api()`.
- **D-S2 (hazard)** No timeout on outbound calls; `instrumentation.ts:7-16` skips ticks while `busy`, so one hung GitLab call (`gitlab-ci.ts:25,74,81`, GitHub/Grafana adapters) blocks cancels, imports and dispatches for good. Fix: shared `AbortSignal.timeout` wrapper.
- **D-S3 (judgement, ADR data-ownership)** `api/board/route.ts:17` calls `getDb().runs({})` on every 15 s poll, scanning all history. Fix: query latest run per work item or cache.
- **D-S4 (GLOSSARY)** `ticket` for work item in `seams.ts`, `db.ts` `RunSummary.ticket`, `board.tsx:76`, `runs/[run]/page.tsx:26`; `Lane`/`lanes()` as a synonym for step. The `ticket` field comes from `run-events`; rename dashboard-side names only.
- **D-S5 (hard, vercel-react-best-practices `after()`)** `api/dispatches/route.ts:19` awaits `startDispatches` before the 202. Fix: `after(...)`.
- **D-S6 (Primitive Obsession)** `targets.ts:10-11` host keys are `string`; `compose.ts:13-32` casts; repeated switches on host key (`targets.ts:27,30,31`, `github-tracker.ts:57`). Fix: union type and one `HOSTS` map.
- **D-S7 (Data Clump)** `{risk, mergeRisk, mergeRiskMax}` through `RunSummary`, `BoardItem`, board route, `RiskPills`, `RunTimeline`, run page; `risk?: string` where `Risk` exists; `${target}/${ticket}` keys built by hand 3×.
- **D-S8 (judgement)** `Record<string, any>` and `as` casts on event data in `step-detail.tsx`, `run-timeline.tsx`; `run-events` has `EVENT_DATA` schemas to infer from.
- **D-S9 (Duplicated Code)** capitalize ×6; `clock` vs `time`; "at N of 10" ×2; reasons box ×3; `Runner.jobs` repeats `Job`; `gitlab-tracker.ts:8` `base()` repeats `gitlabUrl()`; `gitlab-sign-in.ts:16` uses `FACTORY_PROJECT_ID` without the `id()` check.
- **D-S10 (misplaced code)** `github-tracker.ts:4` imports from `gitlab-tracker.ts`; `api/board/route.ts:1` imports from `components/stuck.ts`, which imports `server/db`; `STATE` in `board.tsx:39` vs `STATES` in `seams.ts`.
- **D-S11 (Feature Envy)** `loop.ts:40-48` `newestPipeline` pages through all run events each tick per pending stop. Fix: one SQL query in `db`.
- **D-S12 (Long Function / Divergent Change)** `RunTimeline` ~130 lines, `StepDetail` 8 inline sections, `Db` has 20 methods and `request()` holds refusal rules.
- **D-S13 (composition-patterns)** `ui/alert-dialog.tsx:9-19` `Confirm` has two modes on `trigger`, reads `document.activeElement` and mutates a ref during render.
- **D-S14 (Speculative Generality)** unused `Sheet` props `description`/`footer`; `importEvents(db, sinceHours)` param; unused deps `zustand`, `@tanstack/react-table`, maybe `zod`; unused `ui/scroll-area.tsx`, `ui/tooltip.tsx`; identical `Badge` variants and hard-coded `#353736` instead of `pill-neutral-ink`.
- **D-S15 (Shotgun Surgery)** `switches/page.tsx:20-44` `GROUPS`/`ASK_ON` are not typed against `SwitchName`; a missing name silently loses its column.
- **D-S16 (hazard, low)** `step-detail.tsx:81,178` renders `outcome.url`/`decision.changeUrl` as `href` with no scheme check. Fix: allow only http(s).
- **D-S17 (misc)** "Ruling R4/R18/R22/R46", "spec 6.1" cited in 10 places with no doc; generic names `of`, `at`, `over`, `Row`, `Column`, `Figure`; `Math.max(...times)` on huge runs; empty `catch {}` in `runs/[run]/page.tsx:25`; `useNow` re-renders after the run ends; Google Fonts `<link>` instead of `next/font`; `readTargets()` sync fs + YAML parse per request.

Checked, no finding: API route auth, timing-safe token compare, input validation on `api/switches` and `api/events`, LogQL quoting, job id validation, no vendor words in `app/` or `components/`.

## Spec

### Factory

- **F-P1 (wrong)** A person's hand merge never starts the finish run under `ci: local`. develop-branch §2.7: "After a person merges, the finish pipeline runs". The only merged entry is the webhook (`event.ts:13`); `poll.ts:36-64` has no merged path and `run.ts:200` skips merged changes. The work item stays `needs_approval` and holds a run slot. Fix: poller starts `finish` with `skipApply` for merged `needs_approval` items.
- **F-P2 (wrong)** Inbox comments reach the running author with no injection check. Original §9: "Comment text goes through the Jev 1 `injection` question before an agent reads it." `inbox.ts:29-36`, `steps/context.ts:114-125` only trust-check and wrap. Fix: `injectionYes` per comment in `makeInbox`.
- **F-P3 (wrong)** `reopened_duplicate` evidence fires on duplicate questions too. `triage.ts:111` puts `DEDUPE_MARKER` on the question; `evidence.ts:81-82` counts any marker + open item. Fix: separate close marker.
- **F-P4 (wrong)** Improve can rewrite a file with no evidence. oz H: "only when the same signal shows in at least 3 cases". `improve/proposal.ts:186-194` waives the rule for any confirmed-gone `fix`. Fix: waive only for pure renames.
- **F-P5 (missing)** No reviewer in `seams.yml` can read images (`claude-code.ts:119` `images:false`), so every screen verdict is `unsure` (`proof.ts:86`). change-proof §10. Fix: configure a vision model as reviewer.
- **F-P6 (missing)** Closed-without-merge block omits who closed it (`run.ts:209`). oz C. Fix: add closer to `Change`.
- **F-P7 (missing, specs conflict)** Reviewer never sees target `CLAUDE.md`/`AGENTS.md` (original §6.4); swappable §7 says no context files. Decide and amend one spec.
- **F-P8 (spec drift)** `thresholds.ts:6` `autoMergeConfidenceMin` 0.8 vs oz H 0.9; no line limit (`rules.ts:73`) vs original §6.6 "300 lines" and oz H `maxChangedLines`. Any size can auto-merge. Fix: confirm and update specs.
- **F-P9 (scope creep)** Duplicate close only when the original is older (`triage.ts:101`, `Number(ref)`), so non-numeric refs never close (tool-agnostic §6.8). A request on blocked/needs_info sets ready (`steps/requests.ts:53-59`) where G says the factory replies.
- **F-P10 (scope creep)** Dispatch feature (`steps/dispatch.ts`, `watcher/run.ts` `runDispatches`, `dispatches` switch, worker `/dispatch`) has no spec.
- **F-P11 (partial)** Watcher runs hourly (`worker.ts:324-326`) vs every 10 min; daily cap (`watcher/run.ts:71`) counts all watcher items, not only ready ones.
- **F-P12 (partial)** Tool-agnostic §6: central `secrets.ts` map instead of per-adapter; `worker.ts:27`, `adapters/gitlab-ci.ts:57` name `FACTORY_GITLAB_TOKEN`; `HARNESS_HOMES` in `seams.ts`; verify still blocks on target `smoke` (`verify.ts:12`).

Known: triage default `clarityMin` on failed read (`triage.ts:30`) is followups #2. Followups #1 and #13 look fixed in code, so that list is stale.

### Dashboard

- **D-P1 (wrong, ADR conflict)** Dashboard triggers GitLab pipelines. DEC: "the dashboard may cancel a run's CI pipeline" as the only write. `adapters/gitlab-ci.ts:~66` `startDispatch`, `loop.ts:20-33`, `api/dispatches/route.ts:21`. Fix: new ADR, or move dispatch start to the factory poller.
- **D-P2 (missing)** Step detail Prompt is empty for almost every step (DS §5). Factory sends `step_start` with `{}` (`steps/context.ts:284`, `steps/run.ts:70`); only `fix` sends feedback as prompt. Fix: send masked, cut prompt for agent steps.
- **D-P3 (partial)** "Why it stopped" is not visible (DS §2, §6.5). `StepDetail` never renders `error` events; `stop`/`resume`/`restart` events have no `step` and `lanes()` (`run-timeline.tsx:55`) drops them. Fix: render errors and a "Stopped by X at T" line.
- **D-P4 (wrong)** Server accepts Stop on a non-running run (DS §6.1). `db.ts` `request()` checks only duplicates and ended; a POST on `needs_approval` later sets the item `stopped`. Fix: refuse unless `state(run)` is `running`.
- **D-P5 (wrong)** Board shows Stuck on stopped runs (DS §7). `api/board/route.ts:23` ignores paused/cancelled; the timeline handles it. Fix: skip stuck for `stopped`, `blocked`, `needs_*`.
- **D-P6 (wrong)** Board reads differ between trackers. GitLab includes closed issues, ordered by creation; GitHub uses `state=open`, so closed `factory_done` never shows. Fix: one rule, `order_by=updated_at`.
- **D-P7 (partial)** `gitlab-ci.ts` `importEvents` reads one page of 100 pipelines/jobs, no `ponytail:` note. Fix: page or comment.
- Scope creep: `AUTH_DEV_LOGIN` (dev only); `run_end` outcome `closed` missing from DS §4.1; 7-file backup rotation.

Known: followups #5 (mostly fixed), #11, #12.

## Decisions (2026-11-05)

- D-P1 and F-P10: keep both. New ADR `docs/adr/2026-11-05-dashboard-starts-dispatch-runs.md` allows the dispatch start and specifies dispatches. Fixed.
- F-P7: `.factory/review.md` replaces `CLAUDE.md`/`AGENTS.md` for the reviewer; original spec §6.4 amended. Fixed.
- F-P8: keep 0.8 and no line limit; original spec §6.6 and oz-lessons spec amended. Fixed.
- Fix order: real bugs first (F-S3, F-S4, F-S5, F-P1, F-P2, D-S1, D-P4, D-P5), then smells and glossary renames.

## Summary

Standards: 31 findings (factory 14, dashboard 17); worst are F-S3 (secrets on the command line) and D-S1 (bare `fetch` breaks the sign-in redirect).
Spec: 19 findings (factory 12, dashboard 7); worst are F-P1 (hand merge never finishes under `ci: local`) and D-P1 (dashboard writes to GitLab against the ADR).
