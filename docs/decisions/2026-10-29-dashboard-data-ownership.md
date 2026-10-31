# Dashboard data: GitLab owns state, the dashboard owns events and controls

Date: 2026-10-29

## Decision

- GitLab stays the source of truth for where a work item is: state labels, pipelines, merge requests and job logs. The dashboard reads them through the GitLab API and never keeps its own copy of a work item's state.
- The dashboard owns what GitLab cannot hold: events (steps, tool calls, Jev answers, findings, usage), switches and stop requests. It keeps them in one SQLite file.
- Factory jobs send events to the dashboard while they run. A job also writes every event to `events.jsonl` in its artifacts, and the dashboard imports that file later if it missed events. A failed send never fails a step.
- A run ID, made by the event step and kept in the run record, ties together every pipeline of one run.

## Why

- Steps run as separate CI jobs in short-lived containers, so a local database per run, as in disler/super-simple-software-factory, does not survive between jobs.
- GitLab only shows a run's state after a step ends. Watching the author's tool calls live needs a path outside GitLab.
- Two copies of state would drift. Labels are what people and the factory already act on.

## Consequences

- If the dashboard is down, running steps go on, but the poller starts no new runs, because it cannot read the switches.

## Later

- Live updates use polling: the UI asks every second for events after the last event ID it has. An event-driven design, where events are pushed through a message bus or a stream to the UI and to other consumers, may fit better once more consumers need events or once polling becomes too slow. We chose polling now because it is the simpler design.
