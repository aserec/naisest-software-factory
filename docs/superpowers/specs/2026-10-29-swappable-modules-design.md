# Swappable modules: design

Date: 2026-10-29. Builds on [2026-10-28-software-factory-design.md](2026-10-28-software-factory-design.md).

## 1. Why

The factory is a first MVP. Every outside tool in it is a provisional choice: GitLab work items for tickets, Claude Code as the author, Pi as the reviewer, TensorX and the Team plan for inference, Jev for the judgements, Teams for chat. Any of them may change. A tool change today means edits spread over the steps, because the steps call the `GitLab` class, `runClaude` and `runReviewer` directly.

The goal: each outside tool sits behind a small interface, and a swap means one new adapter file plus one changed line of config. No step changes.

Deep-module rule for every seam: the interface holds only what the steps need, and the implementation hides everything else. For example, steps never see GitLab labels, `iid` numbers, CLI flags or hook formats.

## 2. Goals

1. Every outside tool in the flow sits behind a seam with a small interface (section 5).
2. A config file picks the adapter for each seam. A swap is one new adapter file plus one line of config.
3. Each seam has an in-memory fake. The step tests run on fakes only, as `factory/steps/test-helpers.ts` does today.
4. Each seam has one contract test file. The same tests run against the fake on every push. Against real adapters they run in a manual CI job, because they cost plan quota or API money and need test webhooks and a test GitLab project (my call).
5. Second real adapters prove the seams that matter most now: Pi as author, reviewer and writer next to Claude Code, and a model-call judge next to Jev (section 5).
6. The watcher is built, with a log-source seam and a file adapter that reads fake errors from the repo. It opens real GitLab tickets (section 8).
7. Watcher tickets follow current ticket practice, in two parts: a human part on top and an agent part below (section 9).

## 3. Non-goals

- A Jira adapter. The ticket tracker interface is built so one can be added later.
- A GitHub adapter. Acme uses self-hosted tools only.
- A second code host or CI runner. GitLab stays.
- Loki, GlitchTip or any real log adapter. They wait until the team picks the log technology.
- OpenRouter. It is not safe for EU data (see `docs/research/2026-10-28-eu-sovereign-model-options.md`).

## 4. Anti-goals

The work fails, even if it runs, if any of these hold:

- A tool's word leaks through an interface into a step: `label`, `iid`, `merge request`, `PostToolUse`, `models.json`.
- Adapter choice is spread over the steps instead of one place.
- An adapter is weaker on security than the code it replaces. Section 7 lists the rules every adapter keeps.
- The seams turn into a plugin framework: dynamic loading, a registry, adapter discovery. A plain map from name to constructor in the composition root is enough.
- A seam gets a wide interface that mirrors the tool. The `GitLab` class has about 30 methods. The steps need fewer, in factory words.

## 5. The seams

The composition root stays `makeContext` in `factory/steps/context.ts`. Today `StepContext` holds `gitlab`, `jev`, `teams`, `agents` and `repo`. After this work it holds one field per seam below, and nothing tool-specific.

The interface sketches below show intent. The builder picks exact names and types, but must keep each interface in factory words and about this small.

### 5.1 Ticket tracker

Today: GitLab work items, through the `GitLab` class.

What steps need, in factory words:

- `ticket(ref)`: title, body, state, assignees, web URL.
- `setState(ref, state)`: the factory states (`ready`, `running`, `needs_info`, `needs_approval`, `waiting`, `stopped`, `blocked`, `done`). The GitLab adapter maps them to the `factory_*` labels.
- `comment(ref, text)`, `assign(ref, person)`, `close(ref)`, `reopen(ref)`.
- `list(state)` and `listClosed(count)` for the poller, retry and Jev shadow runs.
- `trusted(actor)`: may this person command the factory? GitLab: Developer role or higher.
- `startedBy(ref)`: who moved the ticket to `ready`.
- `comments(ref, since)`: new member comments, for the run inbox (section 5.4).
- `parseEvent(payload)`: turns a webhook payload into a factory event (`ready`, `@factory` comment, approval). The webhook format is the tracker's business.
- `create(draft)` and `findOpen(fingerprint)`: for the watcher.

Real adapter: GitLab work items. Second adapter: none now.

### 5.2 Code host

Today: GitLab merge requests and the `Repo` interface in `context.ts`.

What steps need:

- The `Repo` interface as it is now: clone, diff, run, commit and push, read file.
- `openChange(branch, title, body)`: open or update the merge request. Returns a change ref.
- `change(ref)`: state, head sha, web URL.
- `approvedByTrusted(ref)`, `checks(ref or sha)`: green, red, running, none.
- `merge(ref, sha)`, `revert(sha)`, `commentChange(ref, text)`, `assignChange(ref, person)`.

Real adapter: GitLab. Second adapter: none.

### 5.3 CI runner

Today: `startPipeline`, `restoreRun`, `buildRecord` and `runArtifacts` on `StepContext` and `GitLab`.

What steps need: start a factory pipeline with variables, load the run record and run files of an earlier pipeline, and read the trusted job variables. `checkVars` and the File-variable secret reading move into the GitLab CI adapter.

Real adapter: GitLab CI. Second adapter: none.

### 5.4 Coding harness

Today: `runClaude` and `runReviewer` in `factory/agents.ts`, with two different shapes.

One interface for both roles:

```ts
run(job: {
  role: "author" | "reviewer" | "writer";
  prompt: string;
  model: ModelChoice;          // provider + model id + effort, from the router
  cwd: string;
  tools: "code" | "none";      // author edits and runs commands; reviewer and writer read only the prompt
  resume?: string;             // a session id from an earlier run
  inbox?: Inbox;               // new ticket comments during the run
  maxTurns: number;
}): Promise<{ session: string; ok: boolean; limitHit: boolean; costUsd: number; tokens: { input: number; output: number }; text: string }>
```

Each adapter hides: the CLI and its flags, the settings file, the sandbox, the dangerous-command guard, how it reads the provider config, how it parses output, and how it resumes a session.

The inbox connector also lives inside the adapter. The spec of 2026-10-28 (section 9, "During a run") asks for new member comments to reach the running agent, and `@factory stop` to pause it. The factory script polls the tracker, because agents hold no tokens, and hands new comments to the `Inbox`. Each harness delivers them in its own way:

- Claude Code: a `PostToolUse` hook that reads the inbox before the next action.
- Pi: an extension that does the same.

Real adapters: Claude Code and Pi. Both adapters fill all three roles.

Inbox scope, my call: `@factory stop` and `@factory resume`. Comment-started runs and merge request comments as blocking findings stay in phase 2, as in the 2026-10-28 spec.

Pi author proof, my call: a contract test plus the sandbox proof in section 7. No approved provider exists for a Pi author today, because Pi cannot use the Team plan and TensorX still waits on its GDPR proof. A real Pi author run happens after that proof.

The reviewer's findings parsing (`parseFindings`) stays in the code review step, because the findings format is the factory's, not the harness's.

### 5.5 Inference provider

Today: the Team plan token for Claude Code, and TensorX hard-coded in `reviewerModels`.

A provider is data, not code: a name, a base URL, the API style (`anthropic` or `openai`), the name of the env variable that holds the key, and the models. Providers live in config. The harness adapter turns a provider into its own config, for example `models.json` for Pi.

Each harness adapter declares which API styles it can use. Config loading fails early when the router pairs a harness with a provider it cannot use.

Rule: the Team plan token works only with the Claude Code harness. See `docs/decisions/2026-10-29-claude-team-plan-auth.md`.

Rule, my call: config loading fails when the author and the reviewer of one router row use the same model family. This replaces today's rule "the reviewer is never Claude while the author is Claude", now that any harness can fill any role. A family is a model line, as `seams.yml` labels it, so Sonnet and Opus are two families. The author and the reviewer may come from the same company.

Real providers: the Team plan and TensorX. TensorX still needs written GDPR proof (see `docs/go-live.md`). Berget AI and Scaleway are the EU fallbacks if TensorX fails that check.

### 5.6 Judge

Today: `JevClient` in `factory/jev.ts`. This is already a deep, small interface: `ask(state, questions) → answers`, with Berget and a mock.

Second adapter: a plain model call through the inference provider seam. It sends the same questions and asks for JSON answers with a value and a confidence. Steps cannot tell the two apart.

### 5.7 Chat

Today: `sendCard` and `buildCard` in `factory/teams.ts`.

What steps need: `notify(kind, title, lines, url)`, where kind is one of needs info, needs approval, blocked, done, waiting, and new watcher ticket. The Adaptive Card format stays inside the Teams adapter.

Real adapter: Teams. Second adapter: none until the team names a second chat tool (my call, the question about Mattermost had no answer).

### 5.8 Log source

New, for the watcher.

What the watcher needs: `errors(since)` returns error groups, each with a fingerprint, a message, event counts per hour, first and last seen, sample lines and a source link. Each adapter owns its query language and its fingerprint rule.

Real adapter: a file adapter that reads log files from `watcher/fixtures/` in this repo. Loki and GlitchTip come later as their own adapters.

## 6. Config

One file, `seams.yml` at the repo root, picks the adapter per seam and lists the providers:

```yaml
tracker: gitlab
codeHost: gitlab
ci: gitlab
judge: jev-berget
chat: teams
logSource: files
providers:
  team-plan: { api: anthropic, keyEnv: CLAUDE_CODE_OAUTH_TOKEN }
  tensorx: { api: openai, baseUrl: https://api.tensorx.ai/v1, keyEnv: TENSORX_API_KEY }
```

`router.yml` changes so each role names a harness, a provider and a model:

```yaml
low:
  author: { harness: claude-code, provider: team-plan, model: claude-sonnet-5-5, effort: medium }
  reviewer: { harness: pi, provider: tensorx, model: tensorx-deepseek-small }
```

The writer role has no triage row, so it gets its own top-level entry. My call: Claude Code on the Team plan with Sonnet, because the fixture data is fake. Real log data needs the team's sign-off on where it may go, as the 2026-10-28 spec says.

```yaml
writer: { harness: claude-code, provider: team-plan, model: claude-sonnet-5-5, effort: medium }
```

Trigger callers can set any CI variable, so `seams.yml` is read from the factory checkout only, never chosen by a variable. The same rule holds for `FACTORY_TARGET` today.

## 7. Security rules every adapter keeps

These rules exist today for Claude Code and GitLab. A new adapter must keep all of them, and its contract test checks the ones code can check:

- No agent process holds a GitLab, chat, trigger or judge token. The env holds only the keys its provider needs.
- The author runs in an OS sandbox with a network allowlist, and with the same read denies as `sandboxDenyRead`.
- A guard blocks dangerous commands, as `.agents/hooks/deny-dangerous.sh` does for Claude Code.
- Nothing from the target repo's own agent config loads: no project settings, skills, extensions or context files.
- Ticket text, comments and log text reach the agent wrapped as data (`wrapTicket`), after the Jev 1 injection question.
- Every secret goes into `addKnownSecrets`.

Pi has no built-in sandbox. The Pi author adapter must get one. One option is to run Pi under Anthropic's open-source sandbox runtime (`srt`), which Claude Code's sandbox is built on. The builder picks the way and proves it with a test that a blocked read and a blocked host fail.

## 8. The watcher

Flow, from the 2026-10-28 spec section 10, with the log source as a seam:

1. A scheduled pipeline runs every 10 minutes.
2. The log source returns error groups that are new or changed since the last run.
3. Code decides which groups are escalating from the hourly counts. Jev does no arithmetic.
4. A script removes customer data from messages and samples.
5. The judge answers the Jev 1 `injection` question on each escalating group's text. My call: a likely injection opens the ticket in the `blocked` state, with no `ready`, and tells chat, so a person looks at it. Otherwise the judge answers `severity` and `fixable`.
6. The watcher skips a group that already has an open ticket (`findOpen(fingerprint)`).
7. It writes the ticket (section 9) and opens it through the tracker with the states `ready` and the `watcher` mark. At most 5 tickets a day get `ready`. After that it opens tickets without `ready` and says so in chat.
8. It sends a chat notice for each new ticket.

Where the tickets go: the watcher opens them in `react_frontend`, and they start real factory runs there (your call).

Rules for runs from fake errors, my calls:

- A ticket with the watcher mark never merges without a person while `logSource` is `files`. The decision step sends it to approval with that reason. A fix for an error that does not exist must not reach `main` alone.
- With `logSource: files`, the watcher runs as a manual pipeline, not on the 10-minute schedule. The fixtures stay recent forever, so a schedule would open the same tickets again after each one closes and use plan limits.
- The fake errors name real files and components in `react_frontend`, so the author has real code to work on.

The fake log files:

- Live in `watcher/fixtures/`, in the repo.
- Hold a mix: errors that grow each hour, errors that stay flat, errors that appear once, an error that matches an open ticket, lines with fake customer data (emails, names, tokens), and one line that tries to give the agent orders.
- Use timestamps relative to the run time, or the adapter shifts them, so the same files stay "recent" on every run.

Tests:

- A unit test runs the watcher on the files with fake tracker, judge and chat. It asserts exactly which groups become tickets, that the scrubber removed every planted customer value, and that the order line was blocked.
- A real run opens real GitLab tickets from the same files.

## 9. Watcher tickets

Each ticket body has two parts, split by a fixed marker line.

**Human part, on top.** Written by a harness run in the `writer` role, with the `humanizer` skill. The skill is not committed today. My call: copy its text into `prompts/` and put it in the writer prompt, because the writer runs with no tools and loads no skills. Plain sentences for a developer reading it in GitLab:

- What is broken, for whom, and since when.
- How often it happens now against before.
- Why the watcher thinks it matters: the judge's severity.
- Acceptance criteria as a short checklist a person can verify.

**Agent part, below.** Fixed structure, filled mostly by code, for the agent that builds the fix:

- Source and fingerprint, for deduplication.
- Evidence as quoted data: counts, first and last seen, the stack trace, scrubbed sample lines.
- Acceptance criteria as testable statements: the failing input, the expected behaviour, and the test that must exist after the fix.
- Constraints: do not change existing tests, stay inside the scope of the error.
- Definition of done: the precommit gate is green and a new test covers the error.

The acceptance criteria appear in both parts. The human part words them for people, the agent part words them as checks.

## 10. Build order

1. Commit `.agents/hooks/`. `runClaude` throws when `deny-dangerous.sh` is missing, so a fresh CI checkout fails today, and the Pi guard reuses the same script. Then extract the seams from today's code with no change in behaviour: tracker, code host and CI from `GitLab`; harness from `agents.ts`; chat from `teams.ts`; judge stays. Steps move to factory words. All current tests pass on the new fakes.
2. One harness interface for Claude Code and Pi in all roles, the provider config, and the new `router.yml` shape.
3. The Pi author adapter with its sandbox and guard.
4. The inbox connector for both harnesses, with `@factory stop`.
5. The judge's model-call adapter.
6. The watcher, the log-source seam, the file adapter, the scrubber and the ticket writer.

## 11. Left to the builder

- Exact names, types and file layout for the seams.
- How the Pi sandbox and guard work, within section 7.
- How the inbox reaches each harness, within section 5.4.
- The confidence rule for the judge's model-call adapter.
- The escalation formula, within the 2026-10-28 spec.
- The exact marker line and ticket template.
