# The dashboard may start a dispatch run

Date: 2026-11-05

## Decision

The dashboard may make a second write to the factory's CI: it starts the factory's `dispatch` run for a target. This amends [the dashboard may cancel a factory pipeline](2026-10-29-dashboard-cancels-pipelines.md), which allowed only a cancel.

A dispatch is how another system tells the factory about a problem, for example a nightly `pip-audit` or a monitor. That system POSTs one JSON object to `POST /api/dispatches` with `FACTORY_DISPATCH_TOKEN`. The dashboard saves it and starts the dispatch run for its target:

- With `ci: gitlab`, through the GitLab trigger API with `FACTORY_TRIGGER_TOKEN` (`startDispatch` in `dashboard/src/server/adapters/gitlab-ci.ts`).
- With `ci: local`, through the worker's `POST /dispatch/<target>` (`dashboard/src/server/adapters/local-ci.ts`, `handler` in `factory/worker.ts`).

The dispatch run (`factory/steps/dispatch.ts`) turns each waiting dispatch into a work item the same way the watcher does: customer data removed, one open work item per `source` and `key`, the injection check, the writer, `factory_ready` or not by the watcher's rules and daily limit of 5, and the watcher mark. A dispatch work item never merges without a person while `logSource` is `files`.

The `dispatches` switch turns dispatches off for a target; they wait until it is on again. A dispatch whose run failed or did not start is started again 15 minutes later (`startDispatches` in `dashboard/src/server/loop.ts`). One dispatch run per target works at a time.

`docs/how-it-works.md`, section "Dispatches", has the request format.

## Why

Outside systems need one place to report a problem, and the dashboard is already the factory's public endpoint. Starting the run at once means the work item appears in minutes, not at the next schedule.

The rule in the earlier decision protects work items: only factory scripts change labels, comments and merges. Starting a dispatch run changes no work item. The factory's own run does every write to the tracker.

## Considered options

- The factory poller reads waiting dispatches from the dashboard and starts the run itself. The dashboard would then make no write but the cancel. This was rejected for now because the start path already works in both CI modes, and the change would add a poll delay.
- No dispatches, only the watcher. This was rejected because the watcher reads only logs, and checks such as a dependency audit produce no log line.
