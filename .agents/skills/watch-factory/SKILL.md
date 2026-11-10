---
name: watch-factory
description: Watches the running local factory loop, fixes factory-side errors, and restarts it only when needed. Use when asked to monitor, babysit, or self-heal the factory.
version: 1.0.0
metadata:
  author: Danel Ceresa <noreply@example.com>
  version: 1.0.0
  tags:
    - factory
    - monitoring
---

# Watch the factory

## Purpose

Use this when the user asks to keep an eye on the local factory that `local-factory.sh` runs, and to fix errors that come from the factory itself. A failure caused by a ticket is the ticket's business: report it, do not fix it. Restart the loop only when a fix cannot reach it without a restart.

One check is done when every run since the last check is classified as healthy, ticket-side or factory-side, and every factory-side error is fixed or reported to the user. Keep checking until the user stops you.

## Instructions

### 1. Read the current state

Run these from the repo root:

```bash
./local-factory.sh status
# status also lists each ticket in progress and its slot; log lines of a run start with [<slot>]
grep -v 'ready ticket(s) wait' ../software-factory.cache/factory.log | tail -60
sqlite3 .cache/factory.db "select at,target,ticket,step,type,substr(data,1,600) from events
  where at > '<last check, ISO UTC>' and type in ('error','run_end','decision','label_change') order by seq"
```

Table `events` columns: seq, id, run, parent, at, target, ticket, pipeline, job, step, type, data. Types include run_start, run_end, step_start, step_end, label_change, decision, error, tool_call, review_finding, gate_check, usage.

Done when you know whether the loop runs, which ticket runs now, and each run end and error since the last check.

### 2. Classify each failure

Sort every `error` event, `blocked` run end, failed poll line and `ended with an error` line with these rules.

#### Healthy

- A run ends at `needs_approval` with a `changeUrl`. The webapp has no CI, so every webapp run ends there.
- A triage outcome other than `go`, such as a duplicate or a ticket that is unclear.
- "N ready ticket(s) wait" while a target has its `maxRuns` active (`targets/<name>.yml`, default 2).

#### Ticket-side

The factory worked, and the ticket or its patch failed. Report it and move on.

- A review finding or gate check that names a defect in the patch.
- A test in the target repo that fails because of the patch.
- A decision that sends the change to a person because of risk.

#### Factory-side

The factory's own code, config, sandbox or machine failed. Fix it.

- A stack trace from a file under `factory/` or `dashboard/`.
- A poll that fails on every minute, for example a missing environment variable.
- A sandbox denial for a command the ticket needs, such as `Operation not permitted` or a denied Bash call.
- A missing tool on the Mac, such as a uv version below the target's required version or a missing `python3.15`.
- The same step blocks on several unrelated tickets.
- A run that has a `run_start` but no `run_end` while no process runs it.

When unsure, read the `tool_call` events of that run: a tool error that would fail any ticket is factory-side.

Done when each failure is labeled healthy, ticket-side or factory-side, with the log line or event that proves it.

### 3. Fix factory-side errors

Use the diagnosing-bugs skill. Fix the root cause in the factory code, add or update a test, and run the factory tests. Commit only when the user asked for commits. Never edit `local-run.sh` or `local-factory.sh` while a run uses them: bash reads a script as it runs, and the edit breaks that run.

Done when the tests that cover the fix pass and the fix is on disk.

### 4. Decide whether to restart

Each step is a fresh `node --import tsx factory/steps/<step>.ts` process, so a fix to code under `factory/` reaches the next step without a restart. A step that is already running keeps its old code. Restart only when one of these holds:

1. The loop is not running (`status` says so).
2. The fix changed `local-factory.sh` itself, or an environment variable the loop passes.
3. The loop process is stuck: no log line and no event for longer than the slowest step takes.

To restart, wait until `status` lists no ticket in progress so no run is cut, then run `factory-musica stop` and `factory-musica start` in the user's zsh. These functions set the tokens and `SLACK_WEBHOOK_URL`. When the shell functions are not available to you, give the user the two commands with the `!` prefix. To retry a ticket blocked by a factory error, set it Ready again on the board.

Done when the loop runs with the fix, or you stated why no restart was needed.

### 5. Wait and check again

Wait about 10 minutes for a running ticket or 20 minutes when idle, then go back to step 1. Use a background Monitor or ScheduleWakeup, never a foreground sleep.

Done when the next check is scheduled.

## Examples

### Ticket-side failure

```text
Input:  run_end {"outcome":"blocked"} at code-review for backend ticket 101,
        review_finding says the patch breaks an existing test.
Result: ticket-side. Report "ticket 101 blocked at code-review: the patch breaks a test". No fix, no restart.
```

### Factory-side failure, no restart

```text
Input:  every backend run blocks at prepare-patch; the tool_call events show
        the author sandbox denies `uv sync` with "Operation not permitted".
Result: factory-side. Fix the sandbox settings in factory code, run the tests,
        set the tickets Ready again. The next run loads the fix; no restart.
```

### Factory-side failure, restart

```text
Input:  log shows "Error: SLACK_WEBHOOK_URL is not set" and "the musicapp_webapp poll failed" every minute.
Result: factory-side. The loop started without the variable. Wait for no ticket in progress,
        then factory-musica stop and factory-musica start.
```

## Prerequisites

The repo is the software-factory checkout, with `.cache/factory.db` and `../software-factory.cache/factory.log`. `sqlite3` is on PATH. The user's zsh defines `factory-musica` and `sf`.

## Limitations

This skill does not fix target repos or tickets. It does not merge or approve pull requests. A ticket at Needs approval is a finished run, not a failure.

## Troubleshooting

**The log only shows "ready ticket(s) wait".** Every slot of that target is taken. Check which tickets hold them: running, waiting and stopped runs count, Needs approval does not. A stale `running` label from a killed run holds a slot until someone moves the ticket.

**A fix did not take effect.** The step that failed was already running when you saved the fix. Set the ticket Ready again and watch the next run.

**`gh` fails with a TLS error.** Use `curl` with `gh auth token` for GitHub API calls.
