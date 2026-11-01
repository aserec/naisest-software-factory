# Software Factory

The factory turns a labeled work item into a reviewed, checked and merged change. This glossary also covers the observability words used to watch it.

## Work

**Work item**:
A GitLab issue that a person labels `factory_ready` to ask the factory for a change.
_Avoid_: Ticket, issue, task

**Run**:
One attempt by the factory to take a work item from `factory_ready` to a final state. A work item has at most one active run.
_Avoid_: Job, execution, workflow

**Step**:
One of the ten fixed stages of a run, such as triage, prepare patch or verify.
_Avoid_: Phase, stage, workflow step

**State label**:
The single `factory_*` label that says where a work item is right now.
_Avoid_: Status

**Run record**:
The saved summary of a run: steps reached, models used, rounds, cost and tokens.
_Avoid_: Report, log

## Agents

**Author**:
The coding agent that writes the tests and the code for a run.
_Avoid_: Coder, builder

**Reviewer**:
The agent that reads the author's diff and returns findings.
_Avoid_: Critic, checker

**Jev**:
The model that answers fixed questions about a work item (Jev 1) or a diff (Jev 2) to set risk.
_Avoid_: Classifier, triage bot

## Control

**Switch**:
An on or off setting that allows or blocks one part of the factory, such as the watcher, new runs or auto-merge, for one target or for every target.
_Avoid_: Toggle, flag, kill switch

**Stop**:
A person's request to halt one run now. A stopped run waits until someone resumes or restarts it.
_Avoid_: Pause, cancel, kill

**Paused run**:
A run that halted before a final state and can still go on: blocked at a step that can continue, waiting at the author's usage limit, or stopped. A run blocked at triage is not a paused run: a ready starts a new run.
_Avoid_: Suspended run, halted run

**Resume**:
Continuing a paused run at the step where it paused, with the same run record and author session.
_Avoid_: Retry, continue

**Restart**:
Ending a stopped run and starting a new run for the same work item from the first step.
_Avoid_: Rerun, reset

## Observability

**Dashboard**:
The web app where people watch runs, read their events and logs, and use stop and switches.
_Avoid_: Visualizer, console, UI

**Event**:
One timestamped fact about a run, such as a step starting, a tool call or a finding.
_Avoid_: Log line, message

**Tool call**:
One action the author takes, such as reading a file, editing code or running tests, with its input, result and duration.
_Avoid_: Turn, action, operation
