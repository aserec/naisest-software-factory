# Plan: PR conflicts on the dashboard, conflict rounds in the poll, seeded proof

Date: 2026-11-06. Asked by the user in the watch-factory session. Do the three parts in order. Write each test first and run `pnpm exec vitest run factory dashboard` after each part. Commit only when the user asks.

Decisions the user made:

- A conflicted PR gets a full round: the author merges the base branch and resolves the conflicts with the `resolving-merge-conflicts` skill. Then code-review, precommit-gate and risk-check run again, and the push happens last.
- The author puts the seed data for its proof in the PR, in the target's own seed scripts, so anyone can reproduce the proof.

## Part 1. Show a conflicted PR on the board card and the run detail

Goal: a person sees on the board card and on the run page that the ticket's PR has conflicts with the base branch.

1. Add `conflicts: boolean` to `Change` in `factory/seams.ts:76`, next to `behind`.
   - GitHub (`factory/adapters/github-code-host.ts`, `change()`): `mergeable === false` or `mergeable_state === "dirty"`. GitHub computes `mergeable` lazily and returns `null` at first. Treat `null` as "not known yet", which means no conflict, and let the next poll read it again.
   - GitLab (`factory/adapters/gitlab-code-host.ts`, `change()`): `has_conflicts`.
   - `fakeCodeHost` in `factory/fakes.ts`: an option that sets it.
2. Decide who reports it to the dashboard. The poll already reads each needs_approval change for request rounds (`pollRequests` in `factory/steps/requests.ts:46`). Find the cheapest place that already holds the change, and send a dashboard event with the `conflicts` value. Look at how `changeUrl` reaches the board, in `dashboard/src/server/board.ts:19` and `dashboard/src/server/db.ts`, and add `conflicts` the same way.
3. Board card: `dashboard/src/components/board.tsx`, near `changeUrl` at line 26. Add a small "Conflicts" badge. Run page: `dashboard/src/app/runs/[run]/page.tsx`, beside the board state that commit d62452e added. Reuse the existing badge component and colors. Add tests in `board.test.tsx` and in the run page's tests.

Done when a change with conflicts shows the badge on both views, a change without conflicts shows none, and the tests cover both cases.

## Part 2. The poll starts a conflict round and pushes the fix

Goal: a ticket at needs_approval whose open PR has conflicts gets a round that merges the base branch, resolves the conflicts, runs the pipeline again and pushes.

1. Reuse the request round in `requestRound` (`factory/steps/requests.ts:65`). It already resumes the author's session at prepare-patch on the same branch, then runs review, gate and risk again, and keeps the change open. A conflict round is a request round whose request text is fixed: "Merge `<base>` into this branch and resolve the conflicts with the resolving-merge-conflicts skill. Keep both sides' intent. Run lint, test and build." Add a new prompt file under `prompts/`, for example `prompts/conflicts.md`, that `prepare-patch` uses for that round. Give the author the skill text. The author runs inside the factory's own sandbox, so do not assume the user's skills are installed there.
2. Trigger: in `pollRequests`, or next to it, take the tickets at needs_approval whose change has `conflicts: true`. Write a cursor line, as `requestRound` does, so the poller does not start the same conflict round again every minute. The next conflict round may start only after the base branch moves again.
3. Local loop: `local-factory.sh` runs `poll.ts --list` (`factory/steps/poll.ts:49`), which today handles only Ready requests and `pollReady`. Request rounds, and so conflict rounds, do not run on the local loop. Find how a round would be handed to `local-run.sh`, which today takes a ticket number only. Do not edit `local-factory.sh` or `local-run.sh` while the loop runs: bash reads them as they run. Ask the user to stop the loop first (`factory-musica stop`).
4. The author's merge needs the base branch in the clone. Check what `cloneAt` in `factory/repo.ts` fetches.
5. Tests: in `factory/steps/flow.test.ts` style, a needs_approval ticket with a conflicted change starts one round, and its prompt names the conflict. A second poll does not start it again. A change without conflicts starts nothing.

Done when the tests pass and a conflicted PR on the local loop gets one round that ends with a push, or ends blocked with the reason.

## Part 3. Tests and proof always show the change, with seeded data

Goal: the author's tests and proof prove what changed. Ticket 452 is the example: every seeded course started in the past, so the "Upcoming" badge could not show in the proof, and the reviewer marked it unsure.

1. `prompts/prepare.md`, section "Proof", rule 27-28 area: when the screen needs data the seed does not have, the author adds it to the target's seed scripts in the same diff. For the webapp that is `scripts/seed-issue-300-demo.ts`, which install runs. The after screen must show the change. Only when no seed can show it, the author writes why in `note`.
2. Same file, tests: each behavior the ticket asks for has a test that fails before the change and passes after it. An empty `tests` list in `proof.json` needs a reason in `note`.
3. `prompts/review.md:22`: make a proof whose after screen cannot show the change, or that lacks before and after tests with no reason, a blocking finding instead of `unsure`.
4. Check `factory/proof.ts` for anything that validates `proof.json` and needs the new rule.

Done when the prompts say this in the repo's prompt style, and the prompt tests (grep `prepare.md` and `review.md` in `factory/*.test.ts`) pass.
