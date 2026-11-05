# Lessons from oz-for-oss, part H: follow-ups

Date: 2026-11-04. Parts G and H were merged into `feat/dispatches` as 1faaba9.

These are the minor items the task reviews and the final review of part H left open. The final review judged every one of them safe to leave for later. None blocks a run.

## Thresholds and loops (Tasks 1 and 2)

1. `factory/steps/jev-shadow.ts:26` calls `decideTriage(a)` with the default `clarityMin`, so it ignores the target's value.
2. `factory/steps/triage.ts:29` uses the default `clarityMin` when the thresholds file cannot be read. No test covers that path.
3. The `risk_checked` mark uses the default for a bad key. The decision still sends that change to a person.
4. No test covers duplicate YAML keys in `thresholds.yml`. The YAML parser throws on them, so the run fails closed.
5. The dashboard badge in `dashboard/src/components/board.tsx:38` shows the default `DIFF_RISK_MAX`, not the target's value.
6. The flow test for the gate round limit does not check how many times the author was asked to fix. The `thresholds` import is out of order in `factory/steps/code-review.ts` and `factory/steps/precommit-gate.ts`. A comment in `factory/loops.test.ts` still says 5.

## Code host and dashboard reads (Tasks 3 and 4)

7. GitHub `changeEdits` throws a bare TypeError when the pull request is missing.
8. `changeEdits` and `changeCommits` stop at 100 items on both hosts. No `ponytail:` comment names that limit.
9. The fake `baseCommits` neither stops at 100 nor sorts newest first. The `changes` map type in `factory/fakes.ts` repeats `title`.
10. GitHub code does not guard against a null commit author or committer. `changeEdits` takes no `since`.
11. The history route returns `[]` when no `type` is given. Repeated `type=` values can grow the statement cache.
12. Times are compared as strings, so an `at` value without milliseconds compares up to 1 second off. The 5,000-event limit drops the newest events without a warning. The fake `history` has no test of its own.

## Evidence (Task 5 and the final review)

13. Evidence comes only from work items with run events in the last 7 days. So `too_strict` misses a change a person merged 8 or more days after its decision. The fix is to read decisions over about 30 days.
14. No test checks the 7-day start for `ticket_reply` or for the duplicate marker.
15. `changeComments` is read without `since`. `changeCommits` is read for every work item. The up to 300 injection checks run one after another.
16. Older decisions are judged against the newest change of the work item. `baseCommits` stops at 100, so an older hand revert can be missed.
17. The `too_strict` and `too_loose` dedupe runs per work item, so two work items that point to the same change still count twice.
18. The secret filter's new `key` match also blanks values such as `issue_key`, `hotkey` or `monkey`.
19. On GitHub, part G's poller now reads two paginated comment lists for each pull request on every poll.

## Fix rules and the improve step (Tasks 6 to 8)

20. The replacement path is worked out per line, so two lines in one fix can get different replacements.
21. A dangling link that points out of the clone counts as gone. A path the job cannot read counts as existing.
22. If the change push fails after the fix merge request is open, the fix stays open with nobody assigned.
23. A second run on the same day keeps the old merge request text. The comment for a failed merge uses the implementer's own wording. Runs on two different days of one week open two change merge requests.
24. A full issue URL after "Closes" in the model's text is not neutralized. A person still has to merge that merge request.
25. If the dashboard goes down during the fix's pipeline wait, the switches count as on and the fix can merge. That follows the factory's rule everywhere.
26. A `.factory/<file>` committed as a folder fails with a raw EISDIR error instead of a clear message. Nothing is written outside the clone.
27. `TSX_IMPORT` in `factory/worker.ts` duplicates `factory/agents.ts:17`. The hourly wiring in the worker's `main` has no test.
