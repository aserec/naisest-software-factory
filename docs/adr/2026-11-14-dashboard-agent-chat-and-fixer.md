# The dashboard agent chat and the fix worker

Date: 2026-11-14

## Decision

The dashboard has an agent chat on every page (`dashboard/src/server/chat.ts`, `/api/chat`). It answers questions about the screen a person is on from the dashboard's own data, with the model in `seams.yml` `chatModel`. It has no write tools. When an answer calls for a change, it ends with a plan.

A person who may act (`controlUser()`, the same check as Stop and Settings save) approves a plan. The dashboard stores it. It writes nothing to a tracker, a code host or CI for a plan, so [the dashboard may cancel a factory pipeline](2026-10-29-dashboard-cancels-pipelines.md) and its amendments still hold.

The fix worker (`factory/fixer.ts`, the `fixer` service in `deploy/compose.yml`) claims approved plans through `GET /api/factory/plans` with the factory token, one at a time, and runs the fix step (`factory/steps/fix.ts`) for each. The fix step works in a fresh clone, never in the running checkout. A change to a target repo becomes a change request like any factory change. A change to the factory becomes a PR on `seams.yml` `factoryRepo`, and takes effect only when a person merges it. The fix agent gets the approved plan and the ids it names, not the chat text.

## Why

People who watch the factory could not tell why a run failed without reading events and logs by hand. The design is in [the agent chat design](../superpowers/specs/2026-11-08-dashboard-agent-chat-design.md).

The fix worker is a loop of its own, so restarting the ticket loop never ends a fix in progress. Keeping every write in the factory keeps one place that holds write tokens.

## Considered options

- Let the dashboard open the PRs itself. This was rejected because the dashboard would then hold a write token for the factory repo and every target.
- Run fixes inside the ticket loop. This was rejected because the loop polls only between runs, so a fix could wait for a whole ticket.
