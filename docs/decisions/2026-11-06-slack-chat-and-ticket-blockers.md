# Slack is a chat adapter, and a blocked ticket waits for its blockers

Date: 2026-11-06

## Decision

**Slack.** `chat` in `seams.yml` is `console`, `teams` or `slack`. The Slack adapter (`factory/adapters/slack-chat.ts`) posts the same notice as the Teams card to a Slack incoming webhook (`SLACK_WEBHOOK_URL`, type File): the title in bold, the lines, and an Open link. `seams.yml` picks `slack` today. Teams stays for the outgoing relay (see [the Teams relay decision](2026-11-06-dashboard-relays-teams-messages.md)).

**Ticket blockers.** A work item that the tracker marks as blocked by another open work item does not start. The tracker adapter answers `openBlockers(ref)`: GitLab links of type `is_blocked_by` that are open, or GitHub issue dependencies "blocked by". The poller (`factory/steps/poll.ts`) skips such a ticket and logs which tickets block it. The event step stops with the reason `blocked-by` (`decideStart` in `factory/steps/run.ts`). The ticket keeps `factory_ready`, and starts at the first poll after every blocker is closed.

## Why

A second chat target needed no change outside the adapter, because chat is a seam. Blockers: two patches that build on each other conflict, or fail a gate on `develop`, when they run at the same time. The tracker already holds the order a person wants, so the factory reads it.

## Considered options

- Start blocked tickets and let the merge fail. This was rejected because the second run costs money and ends in a conflict round.
- A blocker list in the target file. This was rejected because people already set blockers in the tracker.
