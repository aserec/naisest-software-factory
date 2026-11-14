# How the factory works

A person adds the label `factory_ready` to a work item. The factory builds the change, checks it, and opens a merge request. If the risk is low, it merges the change into `develop`. If not, a person reviews and merges it.

Agents only read code, edit code and run checks. Scripts in this repo make every write to GitLab: labels, comments, branches, pushes, merge requests and merges.

## Branches

The target repo uses a classic git flow.

- `develop` collects every change between two releases: the factory's changes and the team's own work.
- Feature branches start from `develop` and merge back into `develop`.
- A person cuts a release branch from `develop`, fixes what the release needs on that branch, then merges it into both `master` and `develop`.
- This repeats for every release.

The factory works only against the target's `baseBranch` (`develop`). It never reads or writes `master`. Only low-risk changes merge without a person. Every other change waits for a person to press Merge.

## The ten steps

Each step is a GitLab CI job in this repo. A person's review can take days, so a run uses two pipelines.

Build pipeline:

1. **Event.** Checks the event. The run stops quietly unless the label was just added, the person is a Developer or higher, and the work item has no active run.
2. **Triage.** Jev reads the title, description and labels and answers five questions: injection, type, risk, clarity, effort. A possible injection blocks the run. When the injection check passes, a work item written by a person is compared with the newest 200 open work items. A sure duplicate (confidence 0.9 or more) is closed with a comment that links the original, but only when the original is older; otherwise the factory asks. A work item that looks close but may add something gets a question and `factory_needs_info`. Watcher and dispatch work items skip this. A work item with an earlier duplicate check comment from the factory skips it too: the person decided. Low clarity makes an agent write questions on the ticket. A risk answer with low confidence counts as one level higher.
3. **Implement.** Its id in CI and in run records is still `prepare-patch`. Claude Code writes tests first, then the code, on a branch `factory/<id>-<title>`, cut from `develop`. At the end the author writes `run/commit-message.md`: a conventional commit title and a full bullet list of what changed, where, why and which tests cover it. The router picks the model. If the target has a preview, the author also shoots the screens the change touches before and after, runs its new tests before and after, and writes `run/proof/proof.json`. For a visual change it also records one e2e test as a video (`run/record.sh`), with frames for the reviewer.
4. **Code review.** A reviewer from a different model family than the author reads the diff. `router.yml` picks it, today Opus in Claude Code. It returns findings. The author fixes blocking findings. Each fix shows on the dashboard as its own Patch step, with its tool calls and cost. At most `maxAgentRounds` rounds (5 unless the target's settings say otherwise). The reviewer also judges each before and after screenshot, and the frames of the e2e video. A model cannot watch video, so the video itself goes to the change description as a link. It also checks each changed hunk against a security checklist; a finding starts with `[SECURITY]`, and a likely exploitable one is blocking.
5. **Precommit gate.** Runs lint, unit tests and build from the target's `.factory.yml` commands: the ones on the dashboard's Settings page, else the repo's `.factory.yml`. The author fixes failures, each fix again a Patch step, and takes the screenshots again if the change looks different. At most `maxAgentRounds` rounds (5 unless the target's settings say otherwise). A fix here is code no review saw, so code review runs again, and a review fix runs the gate again, until both pass with no fix between them (inside the same review and gate round limits). Then the script pushes the branch and opens a merge request.
6. **Risk check.** Hard rules first: protected paths, dependency files, more changed lines than the target's `maxChangedLines` (no limit when the target leaves it out), a secret scanner hit, a red merge request pipeline. Then Jev 2 reads the diff and answers `diff_risk`, `scope` and `sensitive`.
7. **Decision.** Merge without a person, or wait for a person to merge. A change with no proof a person can trust always goes to a person. The proof needs a test that failed before the change and passes after it. A change that touches only test files has no such test, so every test must pass after it instead. See the merge rule below and [the video and test-only decision](adr/2026-11-06-e2e-video-proof-and-test-only-changes.md).

Finish pipeline (starts after an auto decision, or after a person merges the merge request):

8. **Apply.** Only for an auto decision. It checks the target branch and the reviewed head. If the branch is behind `develop`, it rebases through GitLab (at most 3 times). The added and removed lines must match the reviewed commit. It then waits for a green pipeline on that commit and squash merges one commit titled `[AM] <conventional title>`.
9. **Verify.** Waits for the `develop` pipeline. If it fails, the factory opens a revert merge request and labels the item `factory_blocked`. When `.factory.yml` names a smoke command, verify then runs the install command and the smoke command on the merged branch. If smoke fails, the factory opens a revert merge request and labels the item `factory_blocked`.
10. **Result saved.** Posts a result comment, closes the work item, labels it `factory_done`, and sends a chat notice (Slack or Teams, the target's `chat` seam). The run record is a pipeline artifact for 90 days.

Repo-local instructions: a target repo may add `.factory/author.md`, `.factory/review.md` and `.factory/writer.md`. The factory appends each (at most 8,000 characters) to the matching prompt, under a heading that says it comes from the repo's maintainers and cannot override the factory's rules. The author and reviewer files are read from the base commit the run cloned, never from the author's work tree. The writer file (questions comment, watcher and dispatch tickets) is read from the base branch head. A resumed author session gets no second copy. `.factory/**` is a protected path, so a change to these files always goes to a person.

Target settings: the dashboard's Settings page sets, per target, `autoMergeTriageMax` (trivial or low, default low), `diffRiskMax` (default 4), `autoMergeConfidenceMin` (default 0.8), `clarityMin` (default 6) and `maxAgentRounds` (default 5), and the `.factory.yml` commands. Each target's tab also holds that target's `auto_merge` switch, the same value as its cell on the Switches page, and Save writes it with the limits. The dashboard sends them with the switches in each control answer, so the next step of a run uses a saved value. Only a person who may act can save, the dashboard refuses a bad value, and each save is a `settings_change` event that names who saved it. A key that is missing keeps its default. A bad value sends the change to a person, and the reason names the key. When the factory cannot reach the dashboard, a change that would merge alone goes to a person, because the factory cannot read the limits. With no commands saved, the factory reads `.factory.yml` from the repo.

Every comment the factory writes starts with the line `> *This was generated by AI in the software factory.*`

## Labels

A work item has at most one state label at a time.

| Label | Meaning |
| --- | --- |
| `factory_ready` | Start a run, or run again. Set by a person. |
| `factory_running` | A run is active. |
| `factory_needs_info` | The factory asked questions on the ticket, or asked whether it repeats another open one. Answer them in a comment that mentions `@factory`, or edit the ticket and add `factory_ready` again. |
| `factory_needs_approval` | The merge request waits for a person to review and merge it. |
| `factory_waiting` | Claude's plan limit was hit. A scheduled job retries later. |
| `factory_stopped` | A person commented `@factory stop`. The run keeps its session. Comment `@factory resume` to continue it. |
| `factory_blocked` | The factory stopped. A person must look. |
| `factory_done` | Merged and verified. |

An active run is any of `factory_running`, `factory_waiting`, `factory_stopped`, `factory_needs_approval`. Each repo has 2 run slots. `factory_needs_approval` holds none, since the factory's work on it is done. Adding `factory_ready` to an item that is `factory_needs_info` or `factory_done` starts a new run. On a `factory_blocked` item it continues the blocked run at the step that blocked (prepare patch to decision), with new rounds for that step. It does so only when the factory's newest block comment ends with `Blocked run: pipeline <n>` and that run's record can be loaded and belongs to this item. Otherwise it starts a new run, and if the record was the problem, it comments why.

The factory also adds progress labels. They stay next to the state label. A new run removes all of them except `factory_watcher`; a continued run keeps them.

| Label | Meaning |
| --- | --- |
| `factory_triaged` | Triage passed and the run goes on to build. |
| `factory_risk_<class>` | The triage risk class: `trivial`, `low`, `medium` or `high`. Only one at a time. |
| `factory_implemented` | The author agent finished its change. |
| `factory_reviewed` | Code review passed. Removed when a gate fix sends the change back to review. |
| `factory_checked` | The precommit gate passed, with code review passed on the same code. |
| `factory_risk_checked` | Jev 2 in the risk check passed. Not set when its answers send the change to a person. |
| `factory_merged` | The merge request is merged, by the factory or by a person. |
| `factory_reverted` | The `develop` pipeline was red after the merge, and the factory opened a revert merge request. |
| `factory_watcher` | The watcher opened this ticket from error logs. |

## Stop and resume

While an author agent runs, the factory reads new comments on the work item about once a minute. Comments from people who may command the factory (Developer and above) reach the agent as data. A comment with the line `@factory stop` stops the agent at its next tool call: the item gets `factory_stopped`, and the factory comments `Stopped run: pipeline <n>`. A person then comments the line `@factory resume`: the factory loads that run's record and continues the saved agent session at the step that stopped. A `@factory stop` outside a run does nothing.

A person can also end a run by closing its work item or its merge request. The factory reads the live state of both at the moment it acts, because webhooks can arrive out of order: an item closed and then opened again goes on.

- The author agent's inbox checks both about once a minute. A closed one stops the agent at its next tool call.
- The gate checks right before it pushes, decision checks before it decides, and apply checks before each rebase and before the merge.
- A closed work item ends the run quietly. The factory closes the run's open merge request with the comment `This merge request was closed because a person closed work item #<n>.`, removes the state label and ends the run as `closed`. Marks stay.
- A merge request closed without a merge, while the work item is open, blocks the run with a comment that links it.
- Only a work item in a run state counts (`factory_running`, `factory_waiting`, `factory_stopped`, `factory_needs_approval`), and never one whose own merge request merged. The factory closes the work item itself: the merge request's closing line closes it at the merge, while verify still runs, and result-saved sets `factory_done`.
- A merge request counts only when it is this run's. Every run of a work item uses the same branch, so until the gate pushes, the newest merge request on it belongs to an older run, for example one a restart closed.
- A run with no step running would keep its run slot for good. Every minute the poller checks the work items in `factory_needs_approval`, `factory_waiting` and `factory_stopped`, open or closed, and applies the same two outcomes. It has no run record, so it counts a closed merge request only for a work item past the push: `factory_needs_approval`, or `factory_stopped` with a stop note at decision or apply. A run the poller ends sends no `run_end`, because the poller does not know its run ID.

## Requests on a merge request

A person asks for more work on a factory merge request by writing a comment with `@factory` on the merge request or on its work item.

- **Who may ask.** Only people who may command the factory (Developer and above on GitLab, write access and above on GitHub). The factory's own comments never count, even when they quote `@factory`.
- **What counts.** A comment with `@factory` as a whole word: `@factory-bot` and `a@factory.dev` do not count. A comment with the line `@factory stop` or `@factory resume` is a command, never a request, even with more text around it. A request on a merge request that is closed or merged, or on the merge request of another work item, does nothing.
- **The cursor.** The factory only reads comments newer than its cursor. The cursor is the line `Requests read up to: <time>` at the end of a factory comment: the one that starts a round, the one that sends a change to a person, and the replies and refusals below. With no such line yet, the cursor is the time of the factory's newest comment on the merge request; with neither, no round starts. A reply (any state but `factory_needs_approval`) then falls back to the factory's newest comment on the work item; the poller's reply on a merge request with no factory comment at all answers every request of its 10-minute window. Times are compared as times, not as text.
- **`factory_needs_approval`.** The request starts a round.
- **`factory_running`.** Nothing starts. The author agent hears the comment through its inbox while it works, and the run notes how far the agent read. A request comes in the same `<request author="...">` wrapper as a round's requests, so the agent acts on it; any other comment from a person comes as data.
- **`factory_blocked` and `factory_needs_info`.** The request counts as `factory_ready` from its author. On a blocked item the factory comments `The factory starts again for the request of @<author>.` and sets `factory_ready`. On a needs_info item it comments `The factory read the answer of @<author> and takes the work item up again at triage.` and sets `factory_ready` too. The ready replaces `factory_needs_info`, so the run starts new at triage, which reads the answer. Both comments carry the line `Ready for the request of: <author>` and the cursor line. The poller then starts the run. The event step takes a ready the factory set in the last 15 minutes as that author's, so the trust check applies to the author, and a blocked run continues at the step that blocked, as with the label. A ready from a dashboard restart starts a new run instead. Triage reads every `@factory` comment by a trusted person on the work item, oldest first, as part of the description, so an answer to the factory's questions reaches triage and the agents. The poller does not reply on the merge request of a work item it set ready in the same poll.
- **`factory_stopped` and `factory_waiting`.** One reply on the work item, with the cursor line, that says what to do (comment `@factory resume`, or wait for the usage limit to end) and that the factory takes up the request once the change waits for a person. The next poll does not answer the same request again.
- **Other states** (`ready`, `done`, or none). The reply says that the factory takes requests only while the change waits for a person, and what to do (for `ready`: the run starts soon, so write the request again once the change waits for a person). The poller answers a request on the merge request of such a work item with one short reply on that merge request, with the cursor line. It finds them in one listing of the open merge requests updated in the last 10 minutes (at most 100), so a request older than 10 minutes when the poller was down gets no reply. A request on such a work item itself is answered only by the GitLab webhook.
- **The injection check.** Before a round starts, the judge reads every new request with the triage injection question. If one of them is a likely injection (P(yes) 0.3 or more, or no number), the whole round is refused: the factory comments on the work item that a person must read it, moves the cursor, and the change keeps waiting for a person. If the judge fails, nothing is refused and the cursor does not move, so the next poll tries again.

### How a round runs

A round is one more pass of work on the same run and the same merge request.

1. The event step starts the round: it loads the run's record, takes the work item to `factory_running`, comments `The factory started another round for the requests of @<authors>.`, and clears the marks `implemented`, `reviewed`, `checked` and `risk_checked`. The review and gate counters start at zero. The run keeps its run ID, so the dashboard shows the round's steps under the same run.
2. Prepare-patch resumes the author's saved session with the requests, each in its own `<request author="...">` wrapper. If the saved session cannot be loaded, the author starts again with a new session, the prepare prompt, the ticket and the requests. The author ends with one line per request. A usage limit pauses a round like any run (`factory_waiting`) and the retry continues it.
3. Code review, the precommit gate and the risk check run again, and set the four marks again as each passes.
4. The decision is always `factory_needs_approval`, with `a person asked for changes` as the first reason, even for a ticket that could merge alone, and also when the same run resumes later. The factory comments `The factory finished the round for the requests of @<authors>.` on the merge request with the author's answer (cut to 4,000 characters), then the usual needs-a-person comment ending with the cursor line. The round keeps its own review rounds, gate rounds, cost and tokens in the record.
5. The merge request goes back to the author of the newest request of the round, before the work item's assignee and the code owners.

The cursor of that last comment is the newest of the round's cursor and the newest comment the author's inbox read during the round. A request the author already heard starts no second round. A request written after the author's last run, for example during the risk check, does.

### Conflict rounds

A round also starts with no request when the open merge request has conflicts with `develop` and no conflict round has tried since `develop` moved (`conflictsDue` in `factory/steps/requests.ts`). The poller starts the same round build for it.

1. The factory comments `Conflict round` on the work item (this is the cursor for conflicts, so the poller does not ask again) and sends the merge request's conflict flag to the dashboard, which shows a badge.
2. The factory merges `develop` into the work tree. The author resolves the conflicts, runs lint, test and build, and rewrites the commit message (`prompts/conflicts.md`).
3. Review, gate and risk check run again. The decision is `factory_needs_approval`, as after any round.

A conflict round has no requests, so it skips the injection check and has no authors.

### How the factory hears a request

The deployed factory runs with `ci: local`, where no webhook starts a pipeline, so the poller is the main path. Every minute it reads the new comments of each `factory_needs_approval` work item and its merge request, and starts a round for the oldest item with a request (at most one round per minute). It also sends the replies above for `factory_stopped` and `factory_waiting`, and the reply for the merge request of an item in any other state. The round build carries the merge request. It stops quietly when the work item no longer waits for a person (for example a late second build after the first one paused the run) or when the merge request names a newer build run. A round does not check the `new_runs` switch; the `prepare_patch` switch stops it like any prepare-patch. With `ci: gitlab`, a GitLab comment webhook (a note on the work item, or on a merge request from the same project) starts the same round at once, and the poller stays the fallback.

## The merge rule

A change merges without a person only when all four are true:

1. Jev 1 rated the ticket trivial or low, or only trivial when the target's `autoMergeTriageMax` is trivial.
2. The code review passed and the precommit gate is green.
3. Every hard rule passes.
4. Jev 2 passed its thresholds: `diff_risk` at 4 or below with confidence 0.8 or more, `scope` yes at 0.8 or more, `sensitive` yes at 0.2 or less. These numbers are the defaults. A target can change them on the Settings page.

Otherwise the script labels `factory_needs_approval`, assigns the merge request to a person, posts the reasons on the merge request, and sends one chat notice. Medium and high risk tickets are always built, and always end here.

The person is the first of these. After a round, it is the author of the newest request of that round (see Requests on a merge request).

1. The work item's assignee.
2. The code owner of the changed files. The factory reads the first of `CODEOWNERS`, `.gitlab/CODEOWNERS`, `.github/CODEOWNERS` and `docs/CODEOWNERS` from the base branch. For each changed file the last matching rule wins. The owner of the most changed files wins; ties go to the first in file order. Only a single user counts: groups, teams and emails are skipped, and so is the factory bot or anyone the host does not know or does not trust (Developer or higher on GitLab, write access or higher on GitHub).
3. The target's `defaultApprover`. This is also the answer when there is no CODEOWNERS file or the factory cannot read it.

## Human merges

- An approval starts nothing. Only a person's merge starts the finish pipeline.
- A person reviews, rebases by hand when GitLab asks, and presses Merge. The merge event starts the finish pipeline with apply skipped. The person must be a Developer or higher and not the bot.
- Only merge requests whose source branch starts with `factory/` count.
- Apply runs only after an auto decision. It merges the reviewed change, rebased onto `develop` when needed, after a green pipeline on the rebased commit.
- A failed rebase, or a branch that falls behind again after 3 rebases, goes to `factory_needs_approval` with a comment on the merge request. A person rebases by hand and merges. That merge runs verify and closes the ticket like any other human merge.

## The poller and retry

Four scheduled jobs run for each target (see `docs/add-a-repo.md`). With `ci: local` the worker runs them by itself.

- **Poller**, every minute. It starts a build pipeline for each work item labeled `factory_ready`, oldest first, while the target has fewer than 2 active runs. It skips an item that the tracker marks as blocked by an open work item (GitLab link "is blocked by", GitHub issue dependency) and starts it after every blocker is closed. The dashboard board shows such an item in Ready with a "Waits for #n" badge that names its open blockers. It is the fallback when the label webhook does not fire. It also ends paused runs whose work item or merge request a person closed (see Stop and resume). It reads `@factory` requests on the merge requests that wait for a person and starts a round, and sets blocked and needs_info items ready for a request, answers requests on stopped and waiting items, and answers on the merge requests of items in any other state (see Requests on a merge request). When a person merged the change of a `factory_needs_approval` item by hand, the poller starts its finish run, with apply skipped. It waits until the merge is 2 minutes old, so the merge webhook goes first.
- **Watcher**, every hour, only when `logSource` is a real log source. With `logSource: files` it is manual (see The watcher).
- **Resume waiting** (`resume-waiting`), every hour. It resumes runs labeled `factory_waiting` after a plan limit. The new pipeline loads the old record and Claude session and continues at the step that stopped. If the record or session cannot be used, the item gets `factory_blocked` with a comment.

- **Self-improvement job**, every week. It reads a week of corrections and proposes edits to the repo's factory instructions (see Weekly self-improvement). With `ci: local` the worker keeps the time of the last run in its runs folder, so a restart does not run the job again. It writes that time before the job runs, so a failing job runs again a week later and not every hour. For the same reason, a week in which the `improve` switch is off is skipped, and turning the switch on waits for the next week.

At most 2 runs at once per target, and one run per work item.

The poller also carries out the dashboard's resume and restart requests (see below), so a request waits up to a minute.

## The dashboard

The dashboard at `https://factory.<domain>` shows what the factory does, live. Each step sends it events: steps, tool calls, Jev answers, review findings, checks, label changes, usage and cost. `docs/setup.md` section 10 sets it up.

- **Board.** The work items of each target, by state label.
- **Run.** One run: its steps, tool calls, findings, checks and cost, updated every second, and the GitLab job logs.
- **Runner.** Disk and memory of each runner VM, and its logs of the last 15 minutes (`docker`, `gitlab-runner`, `system`), read from Grafana. Alloy on each VM ships them (`deploy/alloy/runner.alloy`).
- **Switches.** Turn parts of the factory off.
- **Insights.** Runs, cost, time per step, spend against each target's weekly budget, review rounds and risk, for a range of days. A click on a chart opens its runs.
- **Notifications and preferences.** The bell lists how runs ended and what waits for a person, with optional browser notifications. Theme, notifications and the Insights range are saved per user.

Only GitLab users with the Developer role (or higher) on the factory project can sign in. The role is checked again on every action.

### Stop, resume and restart

- **Stop** asks the running step to stop at its next check. The item gets `factory_stopped`, as after `@factory stop`. If the run has not stopped after 60 seconds, the dashboard cancels the pipeline. A cancelled run saved nothing, so it can only be restarted.
- **Resume** continues a stopped run at the step that stopped, as `@factory resume` does. The person must also be trusted on the target project (Developer or higher there), or the poller refuses the request.
- **Restart** ends the stopped run as `factory_blocked` and starts a new run for the item from the beginning. If the old run left a merge request open, the factory closes it with a comment that links the new pipeline. If the new run did not start within 15 minutes, the item goes back to `factory_stopped` with a comment, and a person can press Restart again.
- **Set to Ready** is for a `factory_blocked` or `factory_needs_info` item. The dashboard saves a request, and the poller checks the person is trusted on the target project, comments, and sets `factory_ready`, as the person would. A blocked run continues where it stopped.
- Resume, restart and Set to Ready work only on the item's newest run. For an older run the dashboard refuses with "run is not the ticket's newest run".

### Switches

Each switch is on or off for one target or for all targets (`*`). A switch with no saved value is on, except `merge_all`. A saved off in either row wins.

| Switch | When it is off |
| --- | --- |
| `new_runs` | No new run starts. The item stays `factory_ready` and starts when the switch is on again. |
| `questions` | A run that would ask questions on the ticket stops instead. |
| `prepare_patch` | A run stops before Claude writes the change. |
| `auto_merge` | Every change goes to a person for approval. |
| `merge_all` | Only changes that pass the risk checks merge alone. This switch is off until a person turns it on. When on, every change merges without a person unless the `secret` rule failed, a person asked for changes, or the ticket comes from fake errors. `auto_merge` and `apply` must also be on. |
| `apply` | A run stops before it merges. |
| `retry` | The retry schedule resumes no `factory_waiting` run. |
| `watcher` | The watcher opens no tickets. |
| `improve` | The weekly self-improvement job opens no merge request. |

A run that a switch stopped gets `factory_stopped`. The poller continues it once the switch is on again.

### When the dashboard is down

The factory keeps working. A step never waits for the dashboard or fails because of it: events it cannot send are dropped, so the dashboard misses them. Every switch counts as on, except `new_runs` and `merge_all`: `merge_all` counts as off, and no new run starts while the factory cannot read its switches, and the poller acts on no dashboard request. `@factory stop` and `@factory resume` comments still work.

## The watcher

The watcher opens tickets from error logs. With a real log source the worker runs it once an hour, on the hour. Today it reads fake errors from `watcher/fixtures/` (`logSource: files` in `seams.yml`). Loki and GlitchTip come later as their own adapters.

- **Manual run only.** With `logSource: files`, start it by hand: Run pipeline in the web UI with `FACTORY_SCHEDULE=watch` and `FACTORY_TARGET`, then press play on the manual `watcher` job, or run `worker.ts watch <target>` in the local worker. The fixtures stay recent forever, so a schedule would open the same tickets again after each one closes. The step also refuses a pipeline source other than `web`, but a pipeline variable can fake that value, so it is only a second check. Restrict who may set pipeline variables (project setting "Minimum role to use pipeline variables").
- **What it does.** It takes the error groups seen in the last hour, keeps the escalating ones (code decides, from the hourly counts), removes customer data, and skips a group that already has an open ticket. The judge checks the text for prompt injection: a likely injection opens a `blocked` ticket, written by code only, and a chat notice. Otherwise the judge answers severity and fixable, the writer model writes the human part, and code adds the agent part below a marker line.
- **At most 5 a day.** A watcher ticket gets `ready` only while fewer than 5 watcher tickets were opened today (UTC) and the judge thinks a code change can fix it. Otherwise it opens with no state, and the chat notice says why.
- **No merge without a person.** A ticket with the watcher mark (dispatch tickets have it too) never merges alone while `logSource` is `files`. The decision step sends it to approval: a fix for an error that does not exist must not reach `develop` by itself.

## Dispatches

A dispatch is how any other system tells the factory about a problem: a nightly `pip-audit`, a scheduled check, a monitor. The system POSTs one JSON object to the dashboard. The dashboard saves it and at once starts the factory's `dispatch` run for that target, which turns it into a ticket the same way the watcher does: customer data removed, one open ticket per problem, the injection check, the writer, `ready` or not by the same rules and the same daily limit of 5, and the watcher mark. The `dispatches` switch on the dashboard turns them off; they wait until it is on again. A dispatch whose run failed or did not start is started again 15 minutes later, until a run finishes it. The run takes every waiting dispatch of its target, and one run per target works at a time.

```sh
curl -fsS -X POST "https://factory.<domain>/api/dispatches" \
  -H "Authorization: Bearer $FACTORY_DISPATCH_TOKEN" -H "Content-Type: application/json" \
  -d '{"target":"react_frontend","source":"pip-audit","key":"requirements.txt","title":"Vulnerable Python packages","details":"<the tool output>","link":"<the failed job URL>"}'
```

- `target`: a name from `targets/`. `source`: the system, letters, digits, `.`, `_` and `-`. `key`: what it checked. The same `source` and `key` mean the same problem: while its ticket is open, a new dispatch opens no second one, so a job that fails every night is fine. `title`: one line. `details`: the evidence, at most 20,000 characters. `link`: optional.
- The answer is `202` with the dispatch's `id` (the ticket comes a few minutes later), `400` for a bad body or an unknown target, `401` for a wrong token.
- `FACTORY_DISPATCH_TOKEN` can only add dispatches. It cannot read the dashboard or send run events.

A cron audit as a GitLab CI job in the target repo (a pipeline schedule runs it). Put `FACTORY_DISPATCH_TOKEN` and `FACTORY_URL` in the repo's CI variables (masked):

```yaml
pip-audit:
  image: python:3.12
  rules: [{ if: $CI_PIPELINE_SOURCE == "schedule" }]
  script:
  - pip install pip-audit
  - |
    if ! pip-audit -r requirements.txt > audit.txt 2>&1; then
      cat audit.txt
      python -c 'import json, os; print(json.dumps({"target": "react_frontend", "source": "pip-audit", "key": "requirements.txt", "title": "Vulnerable Python packages", "details": open("audit.txt").read()[-20000:], "link": os.environ["CI_JOB_URL"]}))' |
        curl -fsS -X POST "$FACTORY_URL/api/dispatches" -H "Authorization: Bearer $FACTORY_DISPATCH_TOKEN" -H "Content-Type: application/json" --data-binary @-
      exit 1
    fi
```

## Teams messages in

Mention the target's outgoing webhook in a Teams channel with a work item number, for example `@factory-web #123 the login page is blank`. The dashboard checks Teams' HMAC signature and posts the message on that work item as a quote, from the relay bot. The relay bot is not a member with Developer rights, so the comment does nothing yet. A member opens the work item and adds 👍 to the comment. The factory then reads the quoted text as that member's comment: `@factory stop` stops the run, `@factory resume` resumes it at the next poll, and a `@factory` request is a request. It goes through the injection check like any comment. A 👍 given before the comment was last edited does not count. A message without a number gets a reply asking for one. See [the decision](adr/2026-11-06-dashboard-relays-teams-messages.md).

## Weekly self-improvement

Once a week, for each target, the factory reads how people corrected it and proposes edits to the repo's factory instructions. It does not change anything alone, except one kind of fix (below).

- **Evidence.** The job collects facts from the last 7 days, each with a link:
  - `change_comment`: a person's comment on a factory merge request.
  - `change_edit`: a person's edit to the title or text of a factory merge request.
  - `ticket_reply`: a person's reply on a work item after the factory first wrote there.
  - `agent_rounds`: a run that needed 2 or more review rounds with blocking findings, or 2 or more failed checks.
  - `repeat_finding`: a blocking finding that came back in the next review round.
  - `too_strict`: a change sent to a person that a person then merged this week with no change and no request. The decision may be up to 30 days old.
  - `too_loose`: a change that merged alone, up to 30 days ago, and was reverted this week.
  - `reopened_duplicate`: a work item the factory closed as a duplicate that a person reopened.
  - `@factory` requests are found with the same rule as in Requests on a merge request.
  - A decision about an older merge request of the work item is not judged against its newest one. Two work items with one merge request count once.
- **Data, not orders.** Each text is scrubbed of customer data, cut to 2,000 characters and checked for prompt injection. The job drops a text the check does not clear. At most 300 items go on, checked 10 at a time. The writer gets them as data and has no tools.
- **What the writer may propose.** An edit needs 3 cases: at least 3 pieces of evidence, with their links. The job drops an edit that cites fewer, or a link that is not in the evidence. A fix (below) needs no cases. The writer may change only `.factory/author.md`, `.factory/review.md` and `.factory/writer.md`, each under 8,000 characters. It sees the target's settings but cannot change them. The job checks the edits in code, and again with the diff before it pushes. A change to any other file, or a secret in the diff, stops the job before the push. So does a `.factory` folder, or one of the three files, that is a link: the job writes nothing then. It also puts a zero-width space after the `#` of an issue number and after the first letter of a closing word such as Closes or Fixes in the writer's text, so the merge request closes no issue.
- **One merge request for a person.** The edits go in one merge request on the branch `factory-improve/change-<ISO week>`, such as `change-2026-W45`. A second run in the same week updates that merge request, assigned to the target's `defaultApprover`. It lists the evidence for each file. A person reads it and merges it, or does not. The factory never merges it. Only a fix merges without a person.
- **A fix is its own merge request.** A fix may only replace a path or `<pm> run <script>` command written in backticks in a `.factory/` file with the existing path or command that replaced it, a file with a file and a folder with a folder. The new path must be in the same folder as the old one. It never removes text and never adds, deletes or moves a line. The factory confirms in code that the old path or script is gone and the new one exists. A fix goes in its own merge request on `factory-improve/fix-<ISO week>`, which the factory merges after a green pipeline, when the merge request is still open, its head is the pushed commit, and the `improve`, `auto_merge` and `apply` switches are on. If the dashboard cannot be reached for that read, the fix does not merge. The fix is merged or handed to a person even when the push of the other merge request fails. Any other edit, including removing a dead path, goes into the merge request for a person. An edit proposed as a fix that the factory cannot prove is only a rename goes there too, with a line saying so. If its path is confirmed gone, it needs no 3 cases, and any link it cites must be in the evidence; otherwise it needs 3 cases like any change. If a fix cannot merge, the factory comments why, assigns it to the `defaultApprover` and leaves it open.
- **No evidence, no merge request.** A week with no evidence, or with no edit that passes the checks, opens nothing.
- **When it fails.** If the dashboard is down, the job fails before it writes anything and runs again next week.

