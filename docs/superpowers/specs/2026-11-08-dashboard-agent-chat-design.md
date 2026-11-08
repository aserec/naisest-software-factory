# Dashboard agent chat

## Intent

People who watch the factory from the dashboard often see a run that failed, got blocked or looks stuck, and they cannot tell why. Today the answer means reading events, logs and code by hand, or opening Claude Code on the factory machine and running the watch-factory skill.

The dashboard gets a chat panel on the right side of every page. The chat knows which screen the person is on, so "this run" means the run on the page and "these settings" means the settings tab on the page. People ask why something happened, and they ask the agent to fix it. A fix may change the factory's own code or the target repository, as the watch-factory skill does today.

## Goals

1. Answer questions about the current screen in seconds. Examples are why a run failed or is stuck, what a log line means, and what a setting does.
2. Fix problems on request. The agent may propose a change to the factory code, the target repository, or a setting. Code changes land as PRs.
3. Plan first, act on approval. Before any change, the agent posts a plan in the chat and waits. Nothing changes until a person says go.
4. Share everything. Every signed-in person sees every chat, every plan and every result.
5. Work in both hosting setups. Today the dashboard and the factory run on the same machine. Later the factory runs on separate VMs. The same design covers both.

## Non-goals

1. A general chat about things outside the factory.
2. Fixes without approval. The agent never changes code, settings or the loop on its own.
3. Roles for approval. Any signed-in person may approve a plan.

## Decisions made with the user

1. The chat sits on the right side of the dashboard and is present on every page.
2. The chat uses the current screen as its context: a run page means that run, a settings tab means those settings, the runner page means those logs.
3. The agent may change the factory code and the target repository, like the watch-factory skill, not only press existing buttons.
4. The agent plans and waits for a go before it changes code or a setting. Reading and answering need no approval.
5. Chats are shared. Everyone signed in sees everyone's chats.
6. Any signed-in person may say go. The chat records who approved each plan.
7. A fix may wait up to about a minute before it starts. Answers to questions should come back in seconds.
8. A fix to the factory's own code goes onto a branch with a PR to the factory repository. It takes effect only after a person merges it. The agent never edits the running checkout.

## Calls made without the user

These are design choices made while writing this document. The user has not confirmed them.

1. A separate fix worker runs on each factory machine. `local-factory.sh` runs one ticket at a time and polls only between runs, so a fix hosted by the loop could wait for a whole ticket, and a loop restart would kill it.
2. Approval and chat messages use the existing `controlUser()` check (`dashboard/src/server/control-user.ts`), the same check as Stop and Settings save. "Any signed-in person" in decision 6 means any person that check lets act.
3. The fix agent gets only the approved plan and the ids it names, not the chat text. It runs in its own sandbox profile.
4. A plan is done when its PR is open, or when its setting change is saved. After a factory PR merges, the plan says whether the loop needs a restart, and a person starts it with the existing `restart` request.

## How it works

### Questions run on the dashboard

The dashboard already holds the run events, errors, tool calls and decisions that the runner sends it (`dashboard/src/server/db.ts`), and the settings and switches. When a person sends a message, a new dashboard API route builds a prompt from:

1. the page context sent by the panel, such as the route, target, run id or ticket, and settings tab,
2. the data for that context, read from the dashboard database,
3. the chat so far,
4. the classification rules from `.agents/skills/watch-factory/SKILL.md`: healthy, ticket-side, factory-side.

The route calls the model with no write tools and streams the answer into the panel. When the answer calls for a change, the reply ends with a plan: what will change, where, and whether the loop must restart.

### Fixes run on the runner

The runner already pulls work from the dashboard. The dashboard stores requests (`stop`, `resume`, `restart`, `ready`) and the factory poller reads them through `GET /api/factory/control` and closes them through `POST /api/factory/requests/[id]/done` (`factory/steps/poller.ts`, `factory/adapters/http-dashboard.ts`). The runner always calls the dashboard, so this works whether they share a machine or not.

When a person says go on a plan, the dashboard stores the approved plan as a new request kind. A fix worker, a small long-lived process on each factory machine that is separate from the loop, polls the dashboard about once a minute through the same factory API and token, and claims the plan. It does not depend on `local-factory.sh`, which polls only between ticket runs, and it keeps running when the loop restarts.

The fix worker starts a Claude Code agent through the existing harness (`factory/adapters/claude-code.ts`) in a fresh clone or worktree of the repository the plan names, never in the running checkout. The agent gets the approved plan and the ids it names, not the chat text, so untrusted run text quoted in the chat does not reach it directly. It runs in its own sandbox profile that may write only to its own clone. It follows the watch-factory classification rules:

1. A change to a target repository goes onto a branch with a change request, like any factory change.
2. A change to the factory goes onto a branch with a PR to the factory repository. It takes effect only after a person merges it.
3. A setting change goes through the dashboard's existing settings save, under the approver's name.
4. The agent posts its progress and its result, such as the PR link, back to the dashboard, and the chat shows them.

Restarting the loop is not part of a fix. After a factory PR merges, the plan says whether the loop needs a restart, and a person starts it with the existing `restart` request.

### Shared chats

Chats and their messages live in the dashboard database. A chat belongs to the screen it started on, so everyone who opens that run or that settings tab sees its chats. Each message records its author: a person or the agent. Each plan records its state: proposed, approved by whom, running, done, failed.

## Constraints

1. The dashboard is a web app behind sign-in. The question route must only read. Only an approved plan may cause a change, and only the runner carries it out.
2. Run logs and events hold text from tickets written by outside people. That text may try to instruct the agent. The plan-and-approve step is the main guard. The factory's existing injection check (`factory/triage.ts`) covers tickets today and does not cover chat context.
3. The runner's existing poll interval is about one minute. It is acceptable for a fix to wait that long before it starts.
4. Follow the repo's existing patterns: request kinds in `ControlRequest` (`factory/run-events.ts`), the dashboard `Db` interface, the `Harness` seam, the `Shell` layout in `dashboard/src/components/shell.tsx`.

## Left to the builder

1. The panel's look, width and how it opens and closes on small screens.
2. Which model the question route uses and how the dashboard gets its key.
3. The table layout for chats, messages and plans.
4. How streaming reaches the panel.
5. How the fix agent's progress is reported: run events, chat messages, or both.
6. How much of the page's data goes into the question prompt, and how to cut it when it is too long.
7. How the fix worker starts on each host: a process next to `local-factory.sh` today, a container in `deploy/compose.yml` later.
8. The fix worker's sandbox profile and which secrets it gets.
