# The dashboard relays Teams messages to work items

Date: 2026-11-06

## Decision

The dashboard may post one kind of comment on a work item: a Teams message relayed from a Teams outgoing webhook. This amends [the dashboard may cancel a factory pipeline](2026-10-29-dashboard-cancels-pipelines.md), which keeps every tracker write in factory scripts, and [the dashboard may start a dispatch run](2026-11-05-dashboard-starts-dispatch-runs.md).

A Teams outgoing webhook, one per target, POSTs to `POST /api/teams/<target>` when someone mentions it. The dashboard checks Teams' HMAC signature with `TEAMS_OUTGOING_TOKEN_<TARGET>`, finds the first `#123` in the message, and posts the message on that work item as a quote (`handleTeams` in `dashboard/src/server/teams-bridge.ts`).

The dashboard posts with a separate relay bot, never with the factory's token:

- On GitLab, the relay bot has the Reporter role and its token is `TEAMS_RELAY_GITLAB_TOKEN`.
- On GitHub, the relay bot has read access and its token is `TEAMS_RELAY_GITHUB_TOKEN`.

The relay bot is below Developer, so `trusted()` is false for it and the relay comment itself never counts. Each line is quoted with `> `, and `@factory` is broken with a zero-width space, so no quick action or factory command runs from it.

A person confirms a relay with a 👍 on the tracker. The tracker adapter turns each 👍 into a comment of the person who gave it, with the quoted text, at the time of the 👍 (`factory/relay.ts`). From there the usual rules apply: `trusted()` for that person, the injection check, `@factory stop` in a run, `@factory` requests. A 👍 from before the comment's last edit does not count. A 👍 sends no comment webhook, so the poller resumes a stopped run on a confirmed relayed `@factory resume` (`resumeRelayed` in `factory/steps/run.ts`). The target names the relay bot in `teamsRelay`.

## Why

Spec 2026-10-28 §9 asks for a bridge that Microsoft's servers can reach. The dashboard is already the factory's only public endpoint, behind Caddy with TLS. The runner VMs block inbound traffic, and a separate service would need its own host and certificate.

The rule in the earlier decision protects work items from writes the factory did not make. The relay keeps that rule for labels, merges and runs. The tracker's own login proves who confirmed a relay, so a stolen relay token or a forged Teams message can only post comments that nobody confirms.

## Considered options

- The dashboard saves the message and a factory job posts it, as dispatches do. This keeps every tracker write in factory scripts. It was rejected for now because it needs changes to `db.ts`, `loop.ts` and both CI adapters.
- Relay for people only, and the factory never acts on it. This was rejected because people could then not steer a run from Teams.
- Map a Teams user to a tracker member so that the factory acts on the message. This was rejected because a stolen relay token could then act as a member.
- A Teams bot with an Entra ID identity mapped to the tracker user. This was rejected because whoever takes over the dashboard server could then forge commands, and it needs an Azure bot and SSO between Entra and the tracker.
