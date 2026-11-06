# Factory dashboard: design

Date: 2026-10-29. Builds on [2026-10-29-swappable-modules-design.md](2026-10-29-swappable-modules-design.md). Decisions: [dashboard data ownership](../../decisions/2026-10-29-dashboard-data-ownership.md), [the dashboard may cancel a pipeline](../../decisions/2026-10-29-dashboard-cancels-pipelines.md). Words: [GLOSSARY.md](../../../GLOSSARY.md).

## 1. Why

Today a person sees a run only through labels, comments and CI job logs, and only after a step ends. Nobody can see what the author is doing right now, why a run stopped, or what a run cost. Nobody can stop one run without a comment, or turn off part of the factory for every target at once.

## 2. Goals

1. The developer and the team can debug runs, see where each work item is, and see why it stopped. Each run shows its cost.
2. The author shows at tool-call level, live. Jev and the reviewer show at step level.
3. A person can stop a run, then resume or restart it, and can turn switches on and off.
4. Every stop, resume, restart and switch change is saved with the person and the time.
5. Runner VM logs (Docker, gitlab-runner, system) are readable next to the run.

## 3. Non-goals

- Production logs. They wait for the watcher sign-off.
- Trends across runs, search and filters (v2).

> Later decision: Insights (trends), notifications, preferences and a Set to Ready control now exist. See [the dashboard decision](../../decisions/2026-11-06-dashboard-insights-and-set-to-ready.md).
- Alerts. A step that runs too long gets a stuck mark, nothing more.
- Any GitLab write by the dashboard except a pipeline cancel.
- An event-driven design (a message bus or stream). Recorded as a later option in the data ownership decision.

## 4. Data

GitLab is the source of truth for state: state labels, pipelines, merge requests and job logs. The dashboard reads them through the GitLab API and keeps no copy.

The dashboard owns events, switches and stop, resume and restart requests. It keeps them in one SQLite file (`node:sqlite`, Node 22.13 or later).

A run ID is made by the event step, kept in the run record, and so carried by every pipeline of the run (build, resume and finish load the same record). Every event holds it. The dashboard groups by run ID. A restart makes a new run and a new run ID.

### 4.1 Events

Every event has an id (UUID, made by the sender), the run ID, an optional parent id, a time, the target, the work item, the pipeline and job, the step, a type and data. Tool calls have the step event as parent.

| Type | Data |
|---|---|
| `run_start`, `run_end` | `run_end`: outcome (`done`, `blocked`, `needs_info`, `restarted`) |
| `step_start`, `step_end` | `step_end`: outcome (`next`, `stop`, `stopped`, `waiting`, `error`) |
| `tool_call` | author only: tool name, input, result, duration, ok |
| `jev_answer` | question, answer, confidence |
| `review_finding` | text, blocking, round |
| `gate_check` | command, exit code, output tail |
| `rule_check` | rule, passed, detail |
| `decision` | auto or approval, reasons |
| `label_change` | from, to |
| `usage` | role, model, tokens (input, output, cache read, cache write), cost, context tokens |
| `stop`, `resume`, `restart`, `switch_change` | user, and the switch name and value for a switch change |
| `error` | message |
| `prompt` | role, the agent's prompt, cut to 20 KB |

My call: tool call input and result are cut to 20 KB each before sending. A file read can be megabytes.

### 4.2 Sending

The event sender is a new seam with a real HTTP adapter, a fake and a contract test. Steps never name a tool.

- A failed send never fails or slows a step. The adapter sends in batches in the background and drops the oldest unsent events past 5000.
- Every job also appends every event to `run/events.jsonl`, which is in the job artifacts. The dashboard imports these files from GitLab later and keeps each event id once.
- Before an event is sent or written, every string in it goes through the secret mask: each `findSecrets` hit and each known secret value becomes `[secret]`.
- Live tool calls come from the harness adapters as lines arrive (Claude Code stream-json, Pi JSONL), not after the agent exits.
- Jobs send with the bearer token `FACTORY_DASHBOARD_TOKEN`, a File-type CI variable. The step reads it and deletes the file before any agent runs, and adds it to `addKnownSecrets`. The dashboard URL is fixed in `seams.yml`, never a variable, so a trigger caller cannot send the token elsewhere.

## 5. Screens (v1)

- **Board.** Work items of every target by state label, with the last run's cost and a stuck mark.
- **Run timeline.** One lane per step and agent. A step opens into its tool calls.
- **Step detail.** Prompt, findings, gate checks, cost, and the CI job log (read from GitLab when the step opens).
- **Runner view.** Live jobs, disk and memory, and runner logs from Loki.

The UI polls every second with a cursor (the row number of the last event it has). Live and history use the same query. GitLab reads are cached for 15 seconds on the server (my call), so a second-by-second poll does not hit GitLab rate limits.

Everything else links to GitLab. The dashboard is read-only except for stop, resume, restart and switches.

> Later decision: Set to Ready is a fourth control, and preferences are saved per user. See [the dashboard decision](../../decisions/2026-11-06-dashboard-insights-and-set-to-ready.md).

## 6. Control

### 6.1 Stop

1. A person presses Stop on a running run. The dashboard saves a stop request and a `stop` event.
2. The running step reads it through the same inbox as `@factory stop` (swappable modules Task 8), between tool calls, and ends the author. The factory script sets `stopped` and comments on the work item.
3. If no `step_end` with outcome `stopped` arrives within 60 seconds, the dashboard cancels the run's pipeline through the GitLab API. This is its only GitLab write.
4. After a cancel, the next poller run sets `stopped` and comments, because the cancelled job could not.

My call: a run ended by a pipeline cancel can only be restarted, not resumed. The cancelled job saved no record or session.

### 6.2 Resume and restart

A stopped run shows Resume and Restart. The dashboard writes no labels. It saves a request, and the poller (every minute) carries it out as a factory script:

- **Resume:** continue at the stopped step with the saved record and session, through the same path as `@factory resume`.
- **Restart:** end the run as `blocked` with a comment, set `ready`, and start a new run. The event step accepts this start because the dashboard confirms who asked for the restart in the last 15 minutes.

The poller marks the request done. A request waits up to 1 minute. The poller runs every minute instead of every 5 (user decision 2026-10-29).

### 6.3 Switches

Each switch is on or off, for one target or for every target (`*`). A switch with no saved value is on. A switch is on for a target only when both its own value and the `*` value are on.

| Switch | Read by |
|---|---|
| `watcher` | the watcher job |
| `new_runs` | the event step (webhook start) and the poller |
| `retry` | the retry job |
| `questions` | triage, before the questions agent |
| `prepare_patch` | prepare patch |
| `auto_merge` | decision (off: every run asks for approval) |
| `apply` | apply |

Turning a switch off lets current steps finish. A run about to enter a switched-off step stops as `stopped` with the reason "switch off". When the switch is on again, the poller resumes it.

If the dashboard cannot be reached: running steps go on (a switch counts as on), and no new run starts (the poller and the event step count `new_runs` as off).

### 6.4 Who may act

Sign-in is GitLab OAuth. Only people with the Developer role or higher on the factory project may sign in. The role is checked again on every stop, resume, restart and switch change (my call), so a removed person loses control at once.

### 6.5 Audit

Every stop, resume, restart and switch change is saved as an event with the person and the time. The factory comments on the work item when a run stops.

## 7. Stuck marks

A step that runs longer than its limit gets a stuck mark on the board and timeline. No alert.

| Step | Minutes |
|---|---|
| triage | 5 |
| prepare-patch | 120 |
| code-review | 20 |
| precommit-gate | 30 |
| risk-check | 10 |
| verify | 90 |

A target may set other limits in `targets/<name>.yml` under `stuckMinutes`.

## 8. Logs

- CI job logs: read through the GitLab API when a step opens.
- Runner VM logs: Grafana Alloy on the runner manager and on each job VM ships Docker, gitlab-runner and system logs to the existing Loki at `ops.<domain>`. The dashboard queries Loki through Grafana with a Viewer service account token.
- Disk and memory: Alloy's node metrics, read the same way. Alloy ships them to the metrics store at `ops.<domain>`, which exists.

## 9. Stack and hosting

- One Next.js app in `dashboard/` of this repo: API routes are the collector, pages are the UI. The stack is `react_frontend`'s: Next.js 16.2, React 19.2, Tailwind 4, shadcn (style new-york, base color neutral, lucide icons, `radix-ui` ^1.6, cva, tailwind-merge, clsx) added with the shadcn CLI, TanStack Query ^5 and Table ^8, zustand ^5, zod, Vitest ^4, Testing Library, Playwright.
- A pnpm workspace holds the factory (root package `software-factory`) and the dashboard. The event schema is one file in `factory/` that both use. Factory CI jobs install only the factory package, never Next.
- Own small Hetzner VM, `factory.<domain>`, Docker Compose behind Caddy. This repo's CI deploys it on merge to `main`.

## 10. Retention

Tool call inputs and results are kept 90 days. Other events are kept. A nightly job prunes and backs up the SQLite file.
