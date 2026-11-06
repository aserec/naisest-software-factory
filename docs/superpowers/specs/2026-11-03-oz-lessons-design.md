# Lessons from oz-for-oss

Date: 2026-11-03. Status: draft for review.

## Why

We compared the factory with [warpdotdev/oz-for-oss](https://github.com/warpdotdev/oz-for-oss). The factory is ahead on autonomous merge, hard rules and agent isolation. oz-for-oss is ahead on working with people: it reacts to comments on pull requests, routes reviews to code owners, lets each repo tune the agents, finds duplicate issues, and learns from human corrections every week. This design brings those parts into the factory without giving up what makes it autonomous.

The owner decided to keep our own gate model: no spec step before code. The factory asks questions only when it needs them and stops only when it must.

## Goals

1. A person can ask the factory for another round of work on an open factory merge request by writing a comment with `@factory`.
2. The reviewer checks every diff for security faults with a fixed checklist.
3. A run stops when a person closes its work item or its merge request.
4. A change that goes to a person goes to the code owner of the changed files.
5. Each target repo can add its own instructions for the author, the reviewer and the writer.
6. A work item that repeats an open one is closed or questioned before the factory builds it.
7. Once a week the factory reads how people corrected it and proposes changes to its own instructions and thresholds.

## Non-goals

- A product or tech spec step before code. The owner prefers our triage and gates.
- Inline review comments on the merge request. Our reviewer's findings stay internal, so oz's diff-line validation and stale-review dismissal do not apply.
- oz's Vercel and KV control plane. Our worker and poller already do that job.
- A duplicate check for watcher and dispatch work items. Their fingerprint already does it.

## Anti-goals

These would make the work a failure even if it runs:

- An iteration that a person asked for merges without a person.
- A comment that is not a `@factory` request, such as two reviewers talking, starts work.
- The factory closes a person's work item as a duplicate when it is not one.
- Self-improvement changes a criterion, a wording or a threshold without a person's merge.
- An author agent edits the repo's factory instructions in its own change and uses them in the same run.

## Constraints

- Every write to GitLab or GitHub stays in step scripts. Agents get no new tokens or tools.
- Every new path works through the existing seams (`Tracker`, `CodeHost`, `Judge`), so the GitLab, GitHub and GitHub Projects adapters all get it.
- Text written by people reaches models as data, inside a wrapper, after the injection check, like the ticket text today.
- Every new branch of logic leaves a test in the existing vitest style.
- `docs/how-it-works.md` and `GLOSSARY.md` are updated with each part.

## Build order

The parts are independent except H, which writes the files that E reads. Build them in this order: A, B, C, D, E, F, G, H.

## A. Agent loop limit from 3 to 5

Decided by the owner: loops between agents get at most 5 rounds. Loops a person drives have no limit (see G).

- `codeReviewLoop` and `precommitGate` in `factory/loops.ts` default to 5 rounds, and every caller that passes 3 passes 5.
- The rebase limit of 3 in `factory/steps/merge.ts` stays: no agents talk there.
- Update the numbers in `docs/how-it-works.md`.

## B. Security checklist in the reviewer

Decided: copy the checklist of oz's `security-review-pr` skill into `prompts/review.md`.

- Add a section that asks the reviewer to check each changed hunk for: input validation and untrusted data, output encoding (SQL, shell, HTML, URLs), authentication and authorization, secrets, weak crypto and non-crypto randomness for tokens, new or loosened dependencies and curl-to-shell, logging of personal data or tokens, insecure defaults (TLS, CORS, cookies, file modes).
- A security finding starts its text with `[SECURITY]`. A finding that is likely exploitable is blocking. A defense-in-depth idea is not blocking.
- The reviewer reports only faults it can tie to changed lines, and stays silent when nothing applies.
- Keep the answer format unchanged: one JSON array.

## C. Stop a run when its work item or merge request closes

Decided: copy oz's behavior of cancelling work when a person closes the item, and re-read the live state first, because webhooks can arrive out of order.

- While an agent runs, the inbox already reads the tracker about once a minute. It also reads whether the work item and, when there is one, the merge request are still open. A closed one stops the agent at its next tool call, like `@factory stop`.
- Before each step that writes (prepare patch push, decision, apply's rebase and merge), the step re-reads the live state of the work item and the merge request.
- A run whose work item was closed by a person ends quietly: the factory removes its state label and closes its open merge request with a comment that names the reason. A run whose merge request was closed without a merge, while the work item is still open, ends as `factory_blocked` with a comment that says who closed it.
- A run with no step running (`factory_needs_approval`, `factory_waiting`, `factory_stopped`) must also end, or it keeps a run slot for good. The poller, every minute, checks the active work items of the target and their merge requests and applies the same two outcomes. (My call.)
- Builder's call: how the inbox, the steps and the poller share the live-state read.

## D. Reviewer from CODEOWNERS

My call, not discussed in detail: use the CODEOWNERS file that GitLab and GitHub already read, instead of oz's own `STAKEHOLDERS` file.

When the decision step sends a change to a person, it picks the person in this order:

1. The work item's assignee, as today.
2. The code owner of the changed files, read from the target's base branch at `CODEOWNERS`, `.gitlab/CODEOWNERS`, `.github/CODEOWNERS` or `docs/CODEOWNERS`, the first that exists. For each changed file the last matching rule wins, as in GitLab. The owner who owns the most changed files wins; ties go to the first in file order.
3. The target's `defaultApprover`, as today.

Decided by the owner: this works the same on GitHub targets as on GitLab ones. Both hosts use the same file locations above and the same last-match-wins rule, so one parser serves both; on GitHub a user is `@login`, and a team (`@org/team`) counts as a group.

An owner counts only when they are a single user (not a group), not the factory bot, and trusted (Developer or higher on GitLab, write access or higher on GitHub). Builder's call: whether to expand groups later; for now skip them.

## E. Repo-local instructions

Decided by the owner: each target repo can tune the agents, as oz's `*-local` skills do.

- Files in the target repo: `.factory/author.md`, `.factory/review.md`, `.factory/writer.md`, plus `.factory/thresholds.yml` from part H. Each is optional. A missing or empty file changes nothing.
- The factory reads them from the base commit the run cloned, never from the factory branch, so the author cannot change the instructions it runs under.
- The text goes into the matching prompt after the factory's own prompt, under a heading that says it comes from the repo's maintainers. People merged it, so it is trusted, but it cannot override the factory's rules: the factory prompt says so. At most 8,000 characters per file; the rest is cut.
- Add `.factory/**` to `protectedPaths` in every file under `targets/` and in the default, so a change that touches these files always goes to a person.
- Builder's call: whether the questions comment and the dispatch writer read `writer.md` too. The author's commit message and the merge request text follow `author.md`.

## F. Duplicate check for work items written by people

Decided by the owner:

- Same as an open work item: the factory closes the new one with a comment that links the original and says why.
- Similar, but the new one adds something the other does not have: the factory asks on the work item and labels it `factory_needs_info`.

Details, my calls:

- The check runs in triage, after the injection check passes and before the clarity check.
- It compares the new work item with the open work items of the same target project, up to the newest 200, the work item itself excluded. Watcher and dispatch work items skip the check.
- A judge call answers `same`, `adds` or `different`, with the closest work item and a confidence. `same` closes only with confidence 0.9 or more. `same` below 0.9 counts as `adds`, because closing a person's work item by mistake is worse than one extra question.
- The question names the similar work item and what the new one adds, for example "Does this belong in #12, or is it a separate change?".
- When a person adds `factory_ready` again after a duplicate question, or reopens a work item the factory closed as a duplicate and adds `factory_ready`, triage skips the duplicate check: the person decided.
- The `Tracker` seam gets one new read: the open work items of the project, newest first, with a limit.
- Builder's call: how to pick candidates before the judge call (for example by title search) if 200 items do not fit one call.

## G. `@factory` requests on merge requests and work items

Decided by the owner:

- Only a comment with `@factory` starts work. Plain comments between reviewers do not.
- The person must be trusted (Developer or higher) and not the bot.
- The factory does another round of work on the same merge request to fix what the comment asks: a missing screenshot, a broken button or route, a console error, a badly handled 409, anything.
- Rounds that people ask for have no limit. The agent loops inside each round keep their limit of 5.

Details, my calls, accepted in chat unless noted:

- A request is a comment, on the factory merge request (source branch `factory/<id>-...`) or on its work item, that contains `@factory` and is not exactly `@factory stop` or `@factory resume`. The whole comment is the request.
- The work item must be `factory_needs_approval` and the merge request open. A comment on a merged or closed merge request does nothing. While the run is `factory_running`, a request on the work item or the merge request reaches the agent through the inbox, so the inbox also reads the merge request's comments. In any other state the factory replies with one short comment that says what the state allows. (The reply is my call, not discussed.)
- The comment goes through the injection check. A likely injection gets a refusal comment and the work item stays `factory_needs_approval`.
- The round continues the same run at prepare patch, with the saved author session when it can be loaded and a new session when not. The request reaches the author as a person's request, inside the wrapper. Then code review (5 rounds), the precommit gate (5 rounds), the push to the same branch, so the merge request updates, the risk check and the decision.
- After a person's request the decision is always `factory_needs_approval`, with the reason "a person asked for changes", and the merge request goes to the person who wrote the request.
- The progress marks the round resets (`factory_implemented`, `factory_reviewed`, `factory_checked`, `factory_risk_checked`) are removed when the round starts and set again as it passes.
- One round takes every `@factory` request written since the last round started. Requests that arrive while the round runs reach the agent through the inbox.
- When the round ends, the factory comments on the merge request with what it changed for each request.
- The run record lists each round with its request, rounds, cost and tokens. The dashboard shows them as steps of the same run.
- A work item in `factory_needs_approval` already holds one of the target's 2 run slots, so a round never waits for a slot. (My call.)
- How requests are heard, my call: the deployed factory runs with `ci: local`, where no webhook starts a pipeline, so the poller is the main path. Every minute it reads the comments on each `factory_needs_approval` work item and its merge request that are newer than the cursor, and starts a round for the oldest item with a request. The cursor is the time the last round started, else the time the change went to a person; the factory writes it in its own comment when a round starts and when it sends a change to a person, the way `Blocked run: pipeline <n>` is written today. The `CodeHost` seam gets one new read: the comments on a merge request since a time. With `ci: gitlab`, the GitLab tracker's `parseEvent` also reads `note` events on merge requests, so a webhook starts the round at once; the poller stays the fallback.

## H. Weekly self-improvement

Decided by the owner:

- Self-improvement always opens a merge request for a person to merge, except for fixes of instructions that are plainly wrong. Those it commits directly.
- A plainly wrong instruction names a file or command that no longer exists, or contradicts what the code does. Any change of criterion, wording or threshold goes through a merge request.
- The owner's examples of what it must catch: a bad structure of the merge request text, agent loops that go around too many times, unclear language in the factory's comments, an auto-merge threshold that is too strict or too loose.

Details, my calls:

- A new schedule `improve` runs once a week per target, through the worker like the other schedules. A new switch `improve` turns it off.
- A script, not a model, collects the signals of the last 7 days:
  - `@factory` requests and other comments by people on factory merge requests, and edits people made to the title or text of a factory merge request.
  - From run records: rounds per loop, and findings that repeat from one round to the next.
  - Replies by people to factory comments on work items.
  - Decision outcomes: changes sent to a person that were merged with no `@factory` request and no commit by a person (too strict), and auto-merged changes that were reverted (too loose).
  - Work items the factory closed as duplicates that a person reopened.
- The signals go through `factory/watcher/scrub.ts` and the injection check, and reach the model as data.
- A model in the writer role reads the signals, the current `.factory/*.md` files and the current thresholds, and proposes changes. It proposes a change only when the same signal shows in at least 3 cases, and it links every case.
- What it may write, all in the target repo: `.factory/author.md`, `.factory/review.md`, `.factory/writer.md` and `.factory/thresholds.yml`. Before any push, the script checks the changed paths with `git diff` against this list and aborts the job if any other path changed.
- Decided by the owner: the thresholds live in the target repo at `.factory/thresholds.yml`, not in the factory repo. A merged change applies from the next run, with no redeploy and no new token. `.factory/**` is in `protectedPaths` (part E), so an author agent's change to it always goes to a person.
- The thresholds that move from code into that file, with today's values as defaults when the file or a key is missing: `diffRiskMax` (4, `DIFF_RISK_MAX` in `factory/decision.ts`), `autoMergeConfidenceMin` (0.9, `MIN_CONFIDENCE` in `factory/decision.ts`; the default became 0.8 in commit `7dd6195`), `clarityMin` (6), `maxAgentRounds` (5). Triage's `RISK_CONFIDENCE_MIN` (0.7) stays in code, and `maxChangedLines` stays in `targets/<name>.yml` (optional since commit `7dd6195`, with no limit when a target leaves it out). (My calls.)
- The factory reads the file from the base commit the run cloned, like the other `.factory/` files. A value of the wrong type or out of range (for example a confidence outside 0 to 1) fails closed: that run sends its change to a person and names the bad key in the reasons. (My call.)
- Output: at most one merge request per week, in the target repo, assigned to `defaultApprover`, whose text lists each change with its evidence links. No signals means no merge request.
- Direct fixes: the model marks a change as a fix and names the file path or command that no longer exists. Only when the script can confirm that path or command is gone from the repo does the fix skip a person. If it cannot confirm, the change goes into the merge request. A direct fix is its own merge request that the factory merges itself after a green pipeline, through the existing `CodeHost.merge`, so the bot needs no push rights on the protected base branch. (My call.)

## Left to the builder

Everything marked "Builder's call" above, file and function names, the prompt wording, and how each part splits into commits.
