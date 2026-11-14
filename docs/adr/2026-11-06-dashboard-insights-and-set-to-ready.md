# The dashboard shows Insights and lets a person set a work item to Ready

Date: 2026-11-06

## Decision

The dashboard now does more than list runs and offer stop, resume, restart and switches. This amends the line in [the dashboard design](../superpowers/specs/2026-10-29-factory-dashboard-design.md) that puts trends in a later version, and the line that says the dashboard is read-only except for those controls.

- **Insights** (`/insights`, `dashboard/src/server/insights.ts`). For a range of days, it shows runs per bucket (merged without a person, sent to a person, ended without a change), cost and time (p50, p95), time per step, runs per target against `weeklyBudgetUsd`, review rounds and risk. A click on a chart opens the runs behind it. It reads only runs and events the dashboard already holds.
- **Notifications** (the bell, `notifications.tsx`). It lists how the latest runs ended and what turned to wait for a person (needs approval, needs info, stuck). A person may turn on browser notifications for it. The browser's own permission is still needed.
- **Preferences** (`/preferences`, `GET` and `PUT /api/preferences`). Theme, browser notifications and the range Insights opens with. They are saved per user in the dashboard database, so they follow the person to any browser.
- **Set to Ready.** A fourth run action next to stop, resume and restart. On a blocked work item, or one that needs info, a person presses it. The dashboard saves a `ready` request. The poller (`handleReadyRequests` in `factory/steps/run.ts`) checks that the person is trusted on the target project, comments `Set to Ready`, and sets the label. The factory sets the label, not the dashboard. A blocked run continues where it stopped, as with the label.

## Why

Cost, time per step and how often a person has to step in are already in the run events. A person who sees a blocked run also wants to continue it from the same page, without opening the tracker.

Set to Ready keeps [the data ownership rule](2026-10-29-dashboard-data-ownership.md): the dashboard only asks, and the factory makes the write after its own trust check.

## Considered options

- Send Insights to Grafana. This was rejected because the run records are in the dashboard database, and a second copy would drift.
- Let the dashboard set the label itself. This was rejected for the reason in [the Teams relay decision](2026-11-06-dashboard-relays-teams-messages.md): the dashboard posts no label or merge.
