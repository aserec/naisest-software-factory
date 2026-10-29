# Factory Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A web dashboard where the team watches runs live (the author at tool-call level), reads why a run stopped and what it cost, and uses stop, resume, restart and switches.

**Architecture:** One Next.js app in `dashboard/`: API routes are the collector and the control API, pages are the UI, one SQLite file holds events, switches and requests. GitLab stays the source of truth for state and is read through its API. On the factory side, a new `Dashboard` seam sends events and reads switches and stop requests; steps emit events through one `emit` helper that masks secrets and also writes `run/events.jsonl`.

**Tech Stack:** Dashboard: Next.js 16.2, React 19.2, Tailwind 4, shadcn (new-york, neutral, lucide, `radix-ui` ^1.6, cva, tailwind-merge, clsx), TanStack Query ^5, TanStack Table ^8, zustand ^5, zod ^3.25, Vitest ^4, Testing Library, Playwright 1.62, `node:sqlite`, `yaml`. Factory: no new dependencies. Ops: Docker Compose, Caddy, Grafana Alloy.

**Spec:** `docs/superpowers/specs/2026-10-29-factory-dashboard-design.md` (builds on `docs/superpowers/specs/2026-10-29-swappable-modules-design.md` and its plan).

## Global Constraints

- Part B starts only after swappable-modules Task 12 has landed. Part A touches only `dashboard/`, `factory/run-events.ts`, `pnpm-workspace.yaml`, the root `package.json`, `.gitlab-ci.yml` install lines and `factory/ci.test.ts`.
- The dashboard's only GitLab write is a pipeline cancel. Factory scripts make every other write, including the labels for resume and restart.
- A failed or slow send never fails or slows a step. `flush` waits at most 5 s. The send queue holds at most 5000 events and drops the oldest.
- Every string in an event goes through `maskSecrets` before it is sent or written to `run/events.jsonl`.
- Tool call `input` and `result` are cut to 20 KB each (`MAX_FIELD = 20_000` characters).
- `FACTORY_DASHBOARD_TOKEN` is a File-type CI variable: read and deleted before any agent runs, added to `addKnownSecrets`, never given to an agent process. The dashboard URL is `dashboardUrl` in `seams.yml`, never a CI variable.
- Steps never name a tool. The new seam is `Dashboard`; its adapter is picked in the `ADAPTERS` map in `factory/compose.ts` by `seams.yml`.
- Factory CI jobs install with `pnpm install --frozen-lockfile --filter software-factory`. Next never installs in a factory job.
- Only GitLab users with access level 30 (Developer) or higher on the factory project may sign in or act. The role is checked again on every control action.
- UI polls `/api/events` every 1000 ms with a cursor (`seq`, the SQLite row number). GitLab reads are cached 15 s on the server.
- Switch names: `watcher`, `new_runs`, `retry`, `questions`, `prepare_patch`, `auto_merge`, `apply`. Scope is a target name or `*`. No saved value means on.
- Stop fallback: cancel the pipeline 60 s after a stop request with no `step_end` outcome `stopped`.
- Stuck minutes: triage 5, prepare-patch 120, code-review 20, precommit-gate 30, risk-check 10, verify 90; `stuckMinutes` in `targets/<name>.yml` overrides.
- Retention: `tool_call` input and result removed after 90 days; other events kept; nightly prune and `VACUUM INTO` backup, 7 backups kept.
- Simple English in UI copy, comments and docs. No em dashes. Smallest code that works.

## Review Focus

1. The dashboard is down or answers slowly in the middle of a run. Expect the step to finish at its normal speed, `run/events.jsonl` to hold every event, and the dashboard to show them all after the import. Test in Task B1.
2. The author reads a file that holds a token (`glpat-...`, or the value of `FACTORY_GITLAB_TOKEN`). Expect `[secret]` in the sent event and in `events.jsonl`, never the value. Test in Task B2.
3. The same event arrives live, again from the import of `events.jsonl`, and again from a resumed run's copied `run/` dir. Expect it stored once, and a UI holding cursor N to still get every event stored after N. Test in Task A3.
4. A person loses the Developer role, or the session expires, while the page is open. Expect stop, resume, restart and switch changes to return 403 and change nothing. Test in Task A5.
5. Stop pressed twice, stop on a run that already ended, or restart on a run that is still running. Expect one request at most, and a clear refusal for the others. Test in Task A8.

---

## File structure

| File | Responsibility |
|---|---|
| `pnpm-workspace.yaml` | Workspace: root package and `dashboard`. |
| `factory/run-events.ts` | Shared zod schema for events, switch names, request type, stuck limits. Used by factory and dashboard. |
| `dashboard/src/server/db.ts` | SQLite: schema, events, switches, requests, prune, backup. |
| `dashboard/src/server/auth.ts` | GitLab OAuth, sessions, role check, factory bearer check. |
| `dashboard/src/server/gitlab.ts` | GitLab reads (labels, job logs, artifacts, running jobs), pipeline cancel, 15 s cache. |
| `dashboard/src/server/grafana.ts` | Loki and metrics queries through Grafana. |
| `dashboard/src/server/targets.ts` | Reads `targets/*.yml`: name, project path, stuck limits. |
| `dashboard/src/server/loop.ts` | Background loop: stop fallback, import of `events.jsonl`, nightly prune and backup. |
| `dashboard/src/instrumentation.ts` | Starts the loop once per server. |
| `dashboard/src/app/api/**/route.ts` | Collector, control and UI API. |
| `dashboard/src/app/**/page.tsx`, `dashboard/src/components/*.tsx` | Board, run timeline, step detail, runner view, switches. |
| `factory/adapters/http-dashboard.ts` | Dashboard seam over HTTP. |
| `factory/contracts/dashboard.{contract,test,real.test}.ts` | Dashboard seam contract. |
| `factory/emit.ts` | `emit`: mask, cut, write `events.jsonl`, send. |
| `dashboard/Dockerfile`, `deploy/compose.yml`, `deploy/Caddyfile`, `deploy/alloy/*.alloy` | Ops. |

---

## Part A: dashboard only (can start now, in a worktree)

### Task A1: Workspace and app skeleton

**Files:**
- Create: `pnpm-workspace.yaml` (`packages: [".", "dashboard"]`), `dashboard/package.json` (name `factory-dashboard`, deps from the Tech Stack line at the exact versions `~/projects/react_frontend` uses, plus `"software-factory": "workspace:*"`), `dashboard/next.config.ts` (`transpilePackages: ["software-factory"]`, `output: "standalone"`, `serverExternalPackages: ["node:sqlite"]` if the build needs it), `dashboard/tsconfig.json`, `dashboard/vitest.config.ts` (jsdom for `*.test.tsx`, node for the rest), `dashboard/src/app/layout.tsx`, `dashboard/src/app/page.tsx`, `dashboard/src/app/globals.css`, `dashboard/components.json`, `dashboard/src/components/ui/*` (added with `pnpm dlx shadcn@latest init` then `add button badge card table tabs dialog switch tooltip scroll-area`), `dashboard/src/app/page.test.tsx`
- Modify: root `package.json` (add `"exports": { "./run-events": "./factory/run-events.ts", "./config": "./factory/config.ts" }`), `.gitlab-ci.yml`, `factory/ci.test.ts`

**Interfaces:**
- Produces: `components.json` with `style: "new-york"`, `baseColor: "neutral"`, `iconLibrary: "lucide"`, `rsc: true`, aliases under `@/components`. pnpm stays at `pnpm@9.15.9` (root `packageManager`).
- `.gitlab-ci.yml`: the `.factory` install line ends in `pnpm install --frozen-lockfile --filter software-factory`; `smoke` and `contract-real` use `pnpm install --frozen-lockfile --filter software-factory`; new job `dashboard-test` (`tags: [factory]`, `image: node:22`, same rule as `smoke`) runs `corepack enable`, `pnpm install --frozen-lockfile`, `pnpm --filter factory-dashboard typecheck`, `pnpm --filter factory-dashboard test`, `pnpm --filter factory-dashboard build`.

- [ ] **Step 1: Write the failing tests.** In `factory/ci.test.ts`: `INSTALL` ends with `--filter software-factory`; `ci.smoke.script` equals `["corepack enable", "pnpm install --frozen-lockfile --filter software-factory", "pnpm tsc --noEmit", "pnpm vitest run"]`; `ci["dashboard-test"].rules` equals `ci.smoke.rules`. In `dashboard/src/app/page.test.tsx`: the home page renders a heading `Factory`.
- [ ] **Step 2: Run** `pnpm vitest run factory/ci.test.ts`. Expected: FAIL on the install line.
- [ ] **Step 3: Implement** the workspace, the app and the CI lines. Make sure the root `vitest.config.ts` and `tsconfig.json` exclude `dashboard/`.
- [ ] **Step 4: Run** `pnpm install`, `pnpm vitest run`, `pnpm tsc --noEmit`, `pnpm --filter factory-dashboard test`, `pnpm --filter factory-dashboard build`, and `rm -rf node_modules && pnpm install --frozen-lockfile --filter software-factory && ls node_modules/next`. Expected: tests PASS, build succeeds, the last `ls` fails (Next not installed for the factory).
- [ ] **Step 5: Commit** `feat(dashboard): add the workspace and the Next.js app`.

---

### Task A2: Shared event schema

**Files:**
- Create: `factory/run-events.ts`, `factory/run-events.test.ts`

**Interfaces:**
- Produces in `factory/run-events.ts`:

```ts
export const EVENT_TYPES = ["run_start", "run_end", "step_start", "step_end", "tool_call", "jev_answer", "review_finding", "gate_check", "rule_check", "decision", "label_change", "usage", "stop", "resume", "restart", "switch_change", "error"] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export const runEvent: z.ZodType<RunEvent>; // envelope plus data checked against EVENT_DATA[type]
export interface RunEvent { id: string; run: string; parent?: string; at: string; target: string; ticket: string; pipeline?: string; job?: string; step?: string; type: EventType; data: Record<string, unknown> }
export const EVENT_DATA: Record<EventType, z.ZodTypeAny>; // fields per type as in spec 4.1
export const SWITCHES = ["watcher", "new_runs", "retry", "questions", "prepare_patch", "auto_merge", "apply"] as const;
export type SwitchName = (typeof SWITCHES)[number];
export interface ControlRequest { id: string; kind: "stop" | "resume" | "restart"; run: string; target: string; ticket: string; user: string; at: string; outcome?: "stopped" | "cancelled" | "done" | "refused"; doneAt?: string }
export interface ControlState { switches: Record<SwitchName, boolean>; stop: boolean; requests: ControlRequest[] }
export const STUCK_MINUTES: Record<string, number>; // values from Global Constraints
export const MAX_FIELD = 20_000;
```

`EVENT_DATA` keys, camelCase: `run_end {outcome}`, `step_end {outcome}`, `tool_call {name, input, result, ms, ok}`, `jev_answer {question, answer, confidence}`, `review_finding {text, blocking, round}`, `gate_check {command, exitCode, outputTail}`, `rule_check {rule, passed, detail}`, `decision {auto, reasons}`, `label_change {from?, to}`, `usage {role, model, input, output, cacheRead, cacheWrite, costUsd, contextTokens}`, `stop|resume|restart {user}`, `switch_change {user, name, scope, on}`, `error {message}`. Ids are UUIDs, `at` is ISO.

- [ ] **Step 1: Write the failing tests**: a valid `tool_call` parses; a `tool_call` without `ms` fails naming `data.ms`; an unknown `type` fails; an `input` longer than `MAX_FIELD` fails (the sender cuts, the schema guards); `SWITCHES` has 7 names.
- [ ] **Step 2: Run** `pnpm vitest run factory/run-events.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(events): add the event schema shared by the factory and the dashboard`.

---

### Task A3: Storage

**Files:**
- Create: `dashboard/src/server/db.ts`, `dashboard/src/server/db.test.ts`

**Interfaces:**
- Produces:

```ts
export function openDb(path: string): Db; // ":memory:" in tests; creates tables, WAL mode
export interface Db {
  addEvents(events: RunEvent[]): number;                       // INSERT OR IGNORE by id; returns how many were new
  events(q: { run?: string; after?: number; limit?: number }): { events: (RunEvent & { seq: number })[]; cursor: number };
  runs(q: { target?: string; ticket?: string }): RunSummary[];   // from run_start/run_end/usage rows
  switches(target: string): Record<SwitchName, boolean>;        // own value AND "*" value, default true
  setSwitch(scope: string, name: SwitchName, on: boolean, user: string): void; // also adds a switch_change event
  request(r: Omit<ControlRequest, "id" | "at">): ControlRequest | { refused: string };
  requests(q: { target?: string; pending?: boolean; sinceMinutes?: number }): ControlRequest[];
  finish(id: string, outcome: NonNullable<ControlRequest["outcome"]>): void;
  prune(now: Date): void;                                       // json_remove input/result from tool_call older than 90 days
  backup(dir: string, now: Date): void;                         // VACUUM INTO <dir>/factory-YYYY-MM-DD.db, keep 7
}
export interface RunSummary { run: string; target: string; ticket: string; startedAt: string; endedAt?: string; outcome?: string; costUsd: number; lastStep?: { step: string; startedAt: string; ended: boolean } }
```

Tables: `events(seq INTEGER PRIMARY KEY, id TEXT UNIQUE, run, parent, at, target, ticket, pipeline, job, step, type, data TEXT)` with indexes on `(run, seq)` and `(target, ticket)`; `switches(scope, name, on, user, at, PRIMARY KEY(scope, name))`; `requests(id, kind, run, target, ticket, user, at, outcome, done_at)`; `sessions` (Task A5). `request` refuses: a second pending request of the same kind for the run (`already requested`); `stop` when the run has `run_end` (`run already ended`); `resume` or `restart` unless the last `step_end` of the run has outcome `stopped` (`run is not stopped`). `addEvents` with a `step_end` outcome `stopped` finishes pending stop requests of that run with `stopped`.

- [ ] **Step 1: Write the failing tests**: Review Focus 3: add events 1-3, read with `after: 0` (cursor 3), add event 2 again plus event 4, `addEvents` returns 1 and `events({ after: 3 })` returns only event 4; `switches("react_frontend")` is all true by default, false for `apply` after `setSwitch("*", "apply", false, "ana")`, and a `switch_change` event with `user: "ana"` exists; Review Focus 5 (storage half): two stop requests give one row and `{ refused: "already requested" }`, stop after `run_end` and restart before a stopped `step_end` are refused; a `step_end` stopped finishes the stop request; `prune` at day 91 removes `input` and `result` but keeps `name` and `ms`, and keeps a `jev_answer` of the same age untouched; `backup` writes the file and keeps 7 of 8; `runs()` sums `usage.costUsd`.
- [ ] **Step 2: Run** `pnpm --filter factory-dashboard test src/server/db.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with `DatabaseSync` from `node:sqlite` and prepared statements.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(dashboard): store events, switches and requests in SQLite`.

---

### Task A4: Collector and control API for factory jobs

**Files:**
- Create: `dashboard/src/server/auth.ts` (factory part only), `dashboard/src/server/db-instance.ts` (one `Db` from `DASHBOARD_DB`, default `/data/factory.db`), `dashboard/src/app/api/events/route.ts` (POST), `dashboard/src/app/api/factory/control/route.ts`, `dashboard/src/app/api/factory/requests/[id]/done/route.ts`, `dashboard/src/app/api/factory/api.test.ts`

**Interfaces:**
- Produces: `factoryAuthorized(req: Request): boolean`: `Authorization: Bearer <FACTORY_DASHBOARD_TOKEN>` compared with `timingSafeEqual`; false when the env value is unset.
- `POST /api/events`: body `RunEvent[]`, at most 500, each checked with `runEvent`; 401 without the token, 400 naming the first bad index, else `{ added: number }`.
- `GET /api/factory/control?target=<name>&run=<id>`: `ControlState`. `stop` is true when the run has a pending stop request. `requests` holds pending `resume` and `restart` requests of the target, pending `stop` requests with outcome `cancelled`, and `restart` requests done in the last 15 minutes.
- `POST /api/factory/requests/<id>/done`: body `{ outcome }`; calls `db.finish`.

- [ ] **Step 1: Write the failing tests** by calling the route handlers with `new Request(...)` on a `:memory:` db: no token gives 401; a wrong token of the same length gives 401; 501 events give 400; a bad event at index 2 gives 400 with `2` in the message; good events give `{ added: n }`; `control` with a pending stop for the run gives `stop: true`, for another run `stop: false`; a done restart 10 minutes old is in `requests`, one 20 minutes old is not.
- [ ] **Step 2: Run** `pnpm --filter factory-dashboard test src/app/api/factory`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(dashboard): add the collector and control API for factory jobs`.

---

### Task A5: GitLab sign-in

**Files:**
- Modify: `dashboard/src/server/auth.ts`, `dashboard/src/server/db.ts` (`sessions` table)
- Create: `dashboard/src/app/api/auth/login/route.ts`, `.../callback/route.ts`, `.../logout/route.ts`, `dashboard/src/middleware.ts`, `dashboard/src/server/auth.test.ts`

**Interfaces:**
- Env: `GITLAB_URL` (fixed default `https://gitlab.example.com`), `GITLAB_OAUTH_CLIENT_ID`, `GITLAB_OAUTH_CLIENT_SECRET`, `FACTORY_PROJECT_ID`, `DASHBOARD_URL`.
- Produces: `loginUrl(state: string, verifier: string): string` (authorization code flow with PKCE, scope `read_api`); `signIn(code: string, verifier: string, fetchFn?): Promise<Session | { refused: string }>` exchanges the code, reads `/user` and `/projects/:id/members/all/:user_id`, refuses below access level 30; `Session = { id: string; user: string; userId: number; accessLevel: number; gitlabToken: string; expires: string }` stored in `sessions`, 8 h, cookie `factory_session` (`HttpOnly; Secure; SameSite=Lax`) holds only the random id; `currentUser(req: Request): Session | undefined`; `canAct(s: Session, fetchFn?): Promise<boolean>` re-reads the member level with the session's token. `middleware.ts` sends pages without a session to `/api/auth/login` and lets `/api/events`, `/api/factory/*` and `/api/auth/*` through.
- Use a maintained auth library with a GitLab provider (Auth.js, or Better Auth if Auth.js does not support Next 16), pinned to an exact version. It owns the OAuth flow, state check and cookies. `auth.ts` keeps the role check (`canAct`) and the factory bearer check. The signatures above stay where the library allows; adapt `loginUrl` and `signIn` to its callbacks.

- [ ] **Step 1: Write the failing tests** with a fake fetch: a Developer (30) gets a session; a Reporter (20) gets `{ refused: "You need the Developer role on the factory project." }`; a wrong `state` in the callback gives 400; an expired session gives `currentUser` undefined; Review Focus 4: `canAct` is false when the fake now answers 20, and false when it answers 401.
- [ ] **Step 2: Run** `pnpm --filter factory-dashboard test src/server/auth.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(dashboard): sign in with GitLab, Developer role or higher`.

---

### Task A6: GitLab reads, pipeline cancel and the import of events.jsonl

**Files:**
- Create: `dashboard/src/server/gitlab.ts`, `dashboard/src/server/targets.ts`, `dashboard/src/server/gitlab.test.ts`

**Interfaces:**
- Env: `GITLAB_READ_TOKEN` (a bot with Reporter on the factory project and every target, scope `read_api`), `GITLAB_CANCEL_TOKEN` (a project access token on the factory project only, role Developer, scope `api`).
- Produces: `readTargets(dir?: string): { name: string; projectPath: string; stuckMinutes: Record<string, number> }[]` (raw `yaml` parse of `targets/*.yml`, `STUCK_MINUTES` merged with the file's `stuckMinutes`; it does not use `loadTarget`, which refuses placeholder approvers).
- `makeGitLab(fetchFn?, now?)` returns:
  - `board(): Promise<{ target: string; ticket: string; title: string; state: string; url: string; updatedAt: string }[]>`: one issues call per `factory_*` state label per target, cached 15 s.
  - `jobLog(job: string): Promise<string>`: `/projects/:factory/jobs/:id/trace`, last 200 KB.
  - `runningJobs(): Promise<{ job: string; name: string; pipeline: string; startedAt: string; runner?: string }[]>`.
  - `cancelPipeline(pipeline: string): Promise<void>`: the only write, with `GITLAB_CANCEL_TOKEN`.
  - `importEvents(db: Db, sinceHours = 24): Promise<number>`: for factory pipelines updated in the last 24 h, each finished job not yet in table `imported_jobs`, read `run/events.jsonl` from the job artifacts, parse each line with `runEvent` (skip bad lines), `db.addEvents`, record the job id.
- Every id from a caller must match `/^\d+$/` before it goes into a URL.

- [ ] **Step 1: Write the failing tests** with a fake fetch: `board` makes 8 calls per target and none on a second call within 15 s; `jobLog("1/../2")` throws; `cancelPipeline` sends `POST .../pipelines/7/cancel` with the cancel token and no other call uses that token; `importEvents` adds 2 of 3 lines (one bad), and a second call adds 0 and fetches no artifact again; `readTargets` on a temp dir gives `prepare-patch: 120` by default and `60` when the file sets it.
- [ ] **Step 2: Run** `pnpm --filter factory-dashboard test src/server/gitlab.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(dashboard): read GitLab state and import events.jsonl from job artifacts`.

---

### Task A7: Board, run timeline and step detail

**Files:**
- Modify: `dashboard/src/app/api/events/route.ts` (add GET)
- Create: `dashboard/src/app/api/board/route.ts`, `dashboard/src/app/api/jobs/[job]/log/route.ts`, `dashboard/src/app/page.tsx` (board), `dashboard/src/app/runs/[run]/page.tsx`, `dashboard/src/components/board.tsx`, `run-timeline.tsx`, `step-detail.tsx`, `stuck.ts`, their `*.test.tsx`, `dashboard/e2e/screens.spec.ts`, `dashboard/playwright.config.ts`, `dashboard/e2e/seed.ts`
- Modify: `.gitlab-ci.yml` (`dashboard-test` runs Playwright in `mcr.microsoft.com/playwright:v1.62.1-noble`, or a separate `dashboard-e2e` job with that image)

**Interfaces:**
- `GET /api/board`: `gitlab.board()` joined with the latest `RunSummary` per ticket: `{ ...item, run?: string, costUsd?: number, stuck: boolean }[]`.
- `GET /api/events?run=<id>&after=<seq>`: `db.events`, session required. Live and history are this one query.
- `isStuck(lastStep: RunSummary["lastStep"], limits: Record<string, number>, now: Date): boolean` in `stuck.ts`.
- `useRunEvents(run: string)`: TanStack Query, `refetchInterval: 1000`, keeps the cursor and appends; the timeline sorts by `at`.
- Timeline: one lane per step (`step_start` to `step_end`), tool calls nested by `parent`, cost from `usage` events. Step detail: prompt (the `step_start` data `prompt` if present), findings, gate checks, rule checks, Jev answers, cost, and the CI job log loaded only when the panel opens.

- [ ] **Step 1: Write the failing tests**: `isStuck` for prepare-patch at 119 and 121 minutes; `board.tsx` renders a column per state label and a `Stuck` badge; `run-timeline.tsx` with seeded events shows a lane per step and the tool calls under prepare-patch only after a click; the events hook asks with `after=3` after a first answer with cursor 3; `step-detail.tsx` does not call the job log route until opened. `e2e/screens.spec.ts` on a seeded db with a fake session cookie and `GITLAB_*` pointing at a local stub: open the board, open a run, open prepare-patch, see a tool call `Edit`.
- [ ] **Step 2: Run** `pnpm --filter factory-dashboard test`. Expected: FAIL.
- [ ] **Step 3: Implement** with shadcn `Card`, `Badge`, `Table` (TanStack Table for the board list), `Tabs`, `ScrollArea`.
- [ ] **Step 4: Run** `pnpm --filter factory-dashboard test && pnpm --filter factory-dashboard exec playwright test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(dashboard): board, run timeline and step detail`.

---

### Task A8: Controls, switches and the background loop

**Files:**
- Create: `dashboard/src/app/api/runs/[run]/[action]/route.ts` (`stop`, `resume`, `restart`), `dashboard/src/app/api/switches/route.ts` (GET, PUT), `dashboard/src/app/switches/page.tsx`, `dashboard/src/components/run-controls.tsx`, `dashboard/src/server/loop.ts`, `dashboard/src/instrumentation.ts`, tests next to each

**Interfaces:**
- `POST /api/runs/<run>/<action>`: `currentUser` then `canAct` (403 otherwise), then `db.request(...)`; a refusal gives 409 with the reason as text; success adds a `stop`, `resume` or `restart` event with the user.
- `PUT /api/switches` body `{ scope: string; name: SwitchName; on: boolean }`: same checks; `scope` is `*` or a name from `readTargets()`.
- `tick(deps: { db: Db; gitlab: GitLab; now: Date }): Promise<void>` in `loop.ts`: (1) each pending stop request older than 60 s: `gitlab.cancelPipeline(<pipeline of the run's newest step_start>)`, `db.finish(id, "cancelled")` (outcome stays readable by the poller until it calls done, see Task B5); (2) every 10 minutes `gitlab.importEvents(db)`; (3) once a day after 03:00 UTC `db.prune(now)` and `db.backup("/data/backups", now)`. `instrumentation.ts` runs `tick` every 10 s on the Node runtime only, and catches and logs every error.
- `run-controls.tsx`: Stop on a run whose last state label is `factory_running`; Resume and Restart on a stopped run; Resume hidden when the stop was `cancelled` (spec 6.1). Each button asks to confirm in a `Dialog`.

- [ ] **Step 1: Write the failing tests**: Review Focus 5 (API half): a second stop gives 409 `already requested`; restart on a running run gives 409 `run is not stopped`; a Reporter session gives 403 and no row; `PUT /api/switches` with scope `nope` gives 400; `tick` at 59 s cancels nothing, at 61 s cancels pipeline `7` once, and a second `tick` does not cancel again; a stop request already finished as `stopped` is never cancelled; a thrown import does not stop the cancel part.
- [ ] **Step 2: Run** `pnpm --filter factory-dashboard test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(dashboard): stop, resume, restart and switches`.

---

### Task A9: Runner view

**Files:**
- Create: `dashboard/src/server/grafana.ts`, `dashboard/src/server/grafana.test.ts`, `dashboard/src/app/api/runner/route.ts`, `dashboard/src/app/runner/page.tsx`, `dashboard/src/components/runner-view.tsx`

**Interfaces:**
- Env: `GRAFANA_URL` (`https://ops.<domain>`), `GRAFANA_TOKEN` (Viewer service account), `LOKI_UID`, `METRICS_UID`.
- Produces: `runnerLogs(q: { host?: string; source: "docker" | "gitlab-runner" | "system"; minutes: number }, fetchFn?): Promise<{ at: string; host: string; line: string }[]>` through `/api/datasources/proxy/uid/<LOKI_UID>/loki/api/v1/query_range` with LogQL `{job="factory-runner", source="<source>"}` (plus `host` when given), limit 500. `hostStats(fetchFn?): Promise<{ host: string; diskUsedPct: number; memUsedPct: number }[]>` through the metrics data source (`node_filesystem_avail_bytes`, `node_memory_MemAvailable_bytes`).
- `GET /api/runner`: `{ jobs: gitlab.runningJobs(), hosts: hostStats(), logs: runnerLogs(...) }`; a failed Grafana call gives that part `error: string`, never a 500 for the whole view.

- [ ] **Step 1: Write the failing tests** with a fake fetch: the LogQL holds the source label and the `Authorization: Bearer` Grafana token; a `source` outside the three is refused before any fetch; Grafana down gives `logs: { error }` while `jobs` still loads.
- [ ] **Step 2: Run** `pnpm --filter factory-dashboard test src/server/grafana.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(dashboard): runner view with jobs, disk, memory and logs`.

---

## Part B: factory side (start after swappable-modules Task 12)

### Task B1: Dashboard seam, HTTP adapter and the CI variable

**Files:**
- Create: `factory/adapters/http-dashboard.ts`, `factory/adapters/http-dashboard.test.ts`, `factory/contracts/dashboard.contract.ts`, `dashboard.test.ts`, `dashboard.real.test.ts`
- Modify: `factory/seams.ts`, `factory/fakes.ts`, `factory/compose.ts`, `factory/config.ts`, `factory/types.ts`, `seams.yml`, `factory/adapters/gitlab-ci.ts` (`SECRETS` gets `FACTORY_DASHBOARD_TOKEN`), `.gitlab-ci.yml` (every step script passes `FACTORY_DASHBOARD_TOKEN="$FACTORY_DASHBOARD_TOKEN"`), `factory/ci.test.ts` (File variables list), `factory/config.test.ts`

**Interfaces:**
- Produces in `factory/seams.ts`:

```ts
export type { RunEvent, ControlState, SwitchName } from "./run-events";
export interface Dashboard {
  send(e: RunEvent): void;                         // never throws, never waits
  flush(): Promise<void>;                          // at most 5 s
  control(target: string, run?: string): Promise<ControlState>; // throws when the dashboard cannot be reached
  requestDone(id: string, outcome: "done" | "refused"): Promise<void>;
}
```

- `makeHttpDashboard(url: string, token: string, fetchFn?: typeof fetch): Dashboard`: queue in memory, a send every 1 s or at 100 events, `POST <url>/api/events` with at most 500 per call, 5 s timeout per call, a failed batch goes back to the front, the queue drops the oldest past 5000. `control` has a 5 s timeout.
- `fakeDashboard(state?: Partial<ControlState>): Dashboard & { events: RunEvent[]; done: [string, string][]; down: boolean }`.
- `seams.yml`: `dashboard: http` and `dashboardUrl: https://factory.<domain>` (`real` placeholder check as in targets: a `REPLACE_WITH_` value fails load). `SeamsConfig` gets `dashboard: string; dashboardUrl: string`.
- `ADAPTERS.dashboard = { http: makeHttpDashboard }`; `makeContext` reads `ci.secret("FACTORY_DASHBOARD_TOKEN")`, throws when unset, adds it to `addKnownSecrets`, and puts `dashboard` on `StepContext`.
- Target schema gets `stuckMinutes: z.record(z.number().positive()).optional()` (the dashboard reads it; the factory only accepts it).

- [ ] **Step 1: Write the failing tests.** Contract (fake and real): `send` of 3 events then `flush` makes them readable through the contract's read-back hook; `control("react_frontend")` gives all 7 switches; `requestDone` of an unknown id does not throw. Real run: against `DASHBOARD_CONTRACT_URL` and `DASHBOARD_CONTRACT_TOKEN` (a dashboard on a temp db, started by hand). Adapter: Review Focus 1: with a fetch that never answers, 10 000 `send` calls return in under 50 ms total, `flush` returns in at most 5.1 s, and the queue holds the newest 5000; with a fetch that fails once, the batch is sent on the next try in order. `ci.test.ts`: `FACTORY_DASHBOARD_TOKEN` is in the File variables part of `STEP_PREFIX`. `config.test.ts`: `dashboardUrl: REPLACE_WITH_URL` fails.
- [ ] **Step 2: Run** `pnpm vitest run factory/contracts factory/adapters/http-dashboard.test.ts factory/ci.test.ts factory/config.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm vitest run && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(dashboard): add the dashboard seam with an HTTP adapter`.

---

### Task B2: Run ID, emit, and step events

**Files:**
- Create: `factory/emit.ts`, `factory/emit.test.ts`
- Modify: `factory/record.ts` (`runId?: string`), `factory/rules.ts` (`maskSecrets`), `factory/rules.test.ts`, `factory/steps/context.ts` (`runStep`, `agent`, `block`, `stopped`), `factory/steps/event.ts`, `code-review.ts`, `precommit-gate.ts`, `risk-check.ts`, `decision.ts`, `result-saved.ts`, `triage.ts`, `factory/steps/flow.test.ts`

**Interfaces:**
- `maskSecrets(text: string): string` in `rules.ts`: every `SECRET_PATTERNS` match and every known value becomes `[secret]`.
- `emit(ctx: StepContext, type: EventType, data: object, opts?: { parent?: string; id?: string }): string | undefined` in `factory/emit.ts`: does nothing and returns `undefined` when `ctx.record.runId` is unset; else builds the envelope (`target: ctx.target.name`, `ticket`, `pipeline: ctx.ci.vars.run`, `job` from `CI_JOB_ID` via `ctx.ci.vars`, `step: ctx.step`), masks every string leaf, cuts `input`, `result` and `outputTail` to `MAX_FIELD`, appends one line to `<RUN_DIR>/events.jsonl`, calls `ctx.dashboard.send`, returns the id.
- `StepContext` gets `step?: string` and `stepEvent?: string` (set by `runStep`). `RunVars` gets `job?: string` (`CI_JOB_ID`, added to the allowlist and `PATTERNS` as digits).
- Where each event comes from:
  - Event step: on a new start `record.runId = randomUUID()` then `run_start`. A resume keeps the record's `runId`.
  - `runStep`: `step_start` (data `{}`) before `run`, `step_end` with the outcome after, `error` in the catch, then `await ctx.dashboard.flush()` in `finally`.
  - `agent()`: one `usage` event per call (parent: the step event).
  - A decorator in `runStep` wraps `ctx.tracker.setState` (emits `label_change`) and `ctx.judge.ask` (one `jev_answer` per answer). No step changes for these two.
  - Steps: `code-review` emits `review_finding` per finding; `precommit-gate` emits `gate_check` per command; `risk-check` emits `rule_check` per rule; `decision` emits `decision`.
  - `run_end`: `block` (`blocked`), `result-saved` (`done`), the needs-info path in triage (`needs_info`).

- [ ] **Step 1: Write the failing tests.** `rules.test.ts`: `maskSecrets("x glpat-abcdefghijklmnopqrstuv y")` is `x [secret] y`; a known value is masked. `emit.test.ts`: Review Focus 2: an event whose data holds `glpat-...` in a nested array and the known value of `FACTORY_GITLAB_TOKEN` has neither in `fakeDashboard().events` nor in `events.jsonl`; a 1 MB `result` is cut to `MAX_FIELD`; no `runId` means no event and no file. `flow.test.ts`: a full low-risk flow on fakes gives, in order, `run_start`, then `step_start`/`step_end` pairs for each step, at least one `usage`, `jev_answer` from triage and risk-check, `decision`, and ends with `run_end` `done`; every event has the same `run`; a resumed run keeps the run ID; with `fakeDashboard().down = true` the flow ends the same as before.
- [ ] **Step 2: Run** `pnpm vitest run factory/emit.test.ts factory/rules.test.ts factory/steps`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm vitest run && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(events): give each run an ID and send step events to the dashboard`.

---

### Task B3: Live tool calls from the harness adapters

**Files:**
- Modify: `factory/agents.ts` (`runCommand` gets `onLine`), `factory/seams.ts`, `factory/adapters/claude-code.ts`, `factory/adapters/pi.ts`, `factory/fakes.ts`, `factory/contracts/harness.contract.ts`, `factory/steps/context.ts` (`agent`), `factory/adapters/claude-code.test.ts`, `factory/adapters/pi.test.ts`

**Interfaces:**
- `runCommand(cmd, args, env, cwd, stdin?, onLine?: (line: string) => void)`: calls `onLine` per complete stdout line as it arrives; `out` is still the whole output.
- `seams.ts`: `ToolCall = { name: string; input: string; result: string; ms: number; ok: boolean }`; `HarnessJob.onToolCall?: (c: ToolCall) => void`; `HarnessResult.tokens` becomes `{ input: number; output: number; cacheRead: number; cacheWrite: number }` and gets `contextTokens: number` (input plus cache tokens of the last model turn).
- Claude Code: `toolCalls(): { line(l: string): ToolCall[] }` in `claude-code.ts`. An `assistant` line's `tool_use` blocks start a timer by `id`; a `user` line's `tool_result` with that `tool_use_id` gives a `ToolCall` (`ok = !is_error`, `input` as JSON text, `result` as text). Usage cache fields come from `result.usage.cache_read_input_tokens` and `cache_creation_input_tokens`.
- Pi (author, JSON mode from swappable-modules Task 7): the same pairing on Pi's tool start and end events (check the event names against the Pi version on the runner).
- `agent()` passes `onToolCall: (c) => emit(ctx, "tool_call", c, { parent: ctx.stepEvent })` for `role === "author"` only (spec: Jev and reviewer at step level), and puts the new token fields in `usage`.

- [ ] **Step 1: Write the failing tests**: `runCommand` with `node -e` printing 3 lines with a 200 ms pause gives the first `onLine` call before the process ends; `toolCalls()` on a recorded stream fixture (`factory/fixtures/claude-stream-tools.jsonl`: one `Read`, one failing `Bash`) gives two calls with `ok` true then false; harness contract: an author job with tools calls `onToolCall` before `run` resolves (fake: when its script asks for it); `agent` with role `reviewer` passes no `onToolCall`.
- [ ] **Step 2: Run** `pnpm vitest run factory/agents.test.ts factory/adapters factory/contracts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm vitest run && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(harness): send each author tool call to the dashboard as it happens`.

---

### Task B4: Switches in steps and the poller

**Files:**
- Modify: `factory/steps/context.ts` (`switchOn`, `stopped`, `stoppedNote`, `STOPPED_NOTE`), `factory/steps/event.ts`, `poll.ts`, `retry-waiting.ts`, `triage.ts`, `prepare-patch.ts`, `decision.ts`, `apply.ts`, `watcher.ts`, `factory/steps/flow.test.ts`, `factory/steps/poll.test.ts`

**Interfaces:**
- `switchOn(ctx: StepContext, name: SwitchName): Promise<boolean>`: `ctx.dashboard.control(target, runId).switches[name]`; when the dashboard cannot be reached, `true`, except `new_runs`, which gives `false`.
- Task 8's `stopped(ctx, step, session?, extra?)` grows a reason: `stopped(ctx, step: string, o: { session?: string; reason: string; change?: ChangeRef })`. It saves `{ sessionId, switchOff: reason.startsWith("switch off") }`, sets `stopped`, and comments `stoppedNote({ run, step, reason, change, buildRun })`:

```text
Stopped run: pipeline <n>
Stopped step: <step>
Reason: <reason>
Change: <ref>          (finish steps only)
Build run: <n>         (finish steps only)
```

  `parseStoppedNote(body: string)` reads it back; only factory comments count (as `WAITING_RUN` today).
- Step entry: `prepare-patch` and `apply` start with `if (!(await switchOn(ctx, "<name>"))) return stopped(ctx, "<step>", { reason: "switch off <name>" })`; triage does the same before the questions agent; `decision` with `auto_merge` off gives `needs_approval` with reason `auto-merge is switched off`; the event step's `ready` path with `new_runs` off saves `{ start: false, reason: "switch-off" }` and leaves the ticket in `ready`; `retry-waiting` and `watcher` return at once when their switch is off.
- Event step `resume()` accepts a last step with `switchOff: true` and no session, and resumes at that step.
- Poller: `pollReady` returns `[]` when `switchOn(ctx, "new_runs")` is false. New `resumeSwitchedOff(ctx): Promise<TicketRef[]>`: for each `stopped` ticket whose newest factory `Stopped run` note has `Reason: switch off <name>` and that switch is on now, start the same pipeline kind it stopped in: `ci.start({ kind: "build", ticket, buildRun: <pipeline> })`, or for `apply` `ci.start({ kind: "finish", ticket, change, buildRun })`.

- [ ] **Step 1: Write the failing tests** (fakes): `prepare_patch` off stops before any harness job with state `stopped` and the note holding `Reason: switch off prepare_patch`; turning it on and running `resumeSwitchedOff` then the event step resumes at `prepare-patch` and the author runs; `auto_merge` off on a run that would auto-merge gives `needs_approval`; `new_runs` off: a webhook `ready` starts nothing and the state stays `ready`; dashboard down: a running prepare-patch goes on, `pollReady` starts nothing; `apply` off then on starts a `finish` run with the change.
- [ ] **Step 2: Run** `pnpm vitest run factory/steps`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm vitest run && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(switches): steps and the poller obey the dashboard switches`.

---

### Task B5: Dashboard stop through the inbox, and cleanup after a cancel

**Files:**
- Modify: `factory/inbox.ts`, `factory/inbox.test.ts`, `factory/adapters/claude-code.ts`, `factory/adapters/pi.ts` (poll interval), `factory/steps/poll.ts`, `factory/steps/poll.test.ts`, the author callers from swappable-modules Task 8

**Interfaces:**
- `makeInbox(tracker, ticket, since, stopCheck?: () => Promise<boolean>): Inbox`. `poll()` calls `stopCheck` on every call and the tracker at most once every 60 s; `stop` is true when either asks to stop. Author callers pass `stopCheck: async () => (await ctx.dashboard.control(ctx.target.name, ctx.record.runId)).stop` with errors caught as `false`.
- Harness adapters call `inbox.poll()` every 10 s (was 60 s in Task 8).
- A stop from the dashboard ends in `stopped(ctx, step, { session, reason: "stopped from the dashboard" })`, so `step_end` has outcome `stopped`, which finishes the request on the dashboard (Task A3).
- Poller: `finishCancelledStops(ctx): Promise<TicketRef[]>`: for each request in `control(target).requests` with `kind: "stop"` and `outcome: "cancelled"`: if the ticket is still `running`, set `stopped` and comment `The run was stopped from the dashboard by @<user>. The pipeline did not stop within 60 seconds, so it was cancelled. Resume is not possible. Use Restart.`, then `requestDone(id, "done")`.

- [ ] **Step 1: Write the failing tests**: `poll` with `stopCheck` true gives `stop: true` and calls the tracker at most once in two calls 1 s apart; a `stopCheck` that throws gives `stop: false`; flow: a fake harness that sees `stop` returns `stopped: true` and the record step data has `sessionId`; poller: a cancelled stop on a `running` ticket gives state `stopped`, the comment above, and `done` recorded on the fake; on a ticket no longer `running` it only marks done.
- [ ] **Step 2: Run** `pnpm vitest run factory/inbox.test.ts factory/steps`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm vitest run`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(stop): stop a run from the dashboard through the inbox`.

---

### Task B6: Resume and restart requests

**Files:**
- Modify: `factory/steps/poll.ts`, `factory/steps/event.ts`, `factory/steps/poll.test.ts`, `factory/steps/flow.test.ts`

**Interfaces:**
- Poller `handleRequests(ctx): Promise<void>`, run before `pollReady` and only when the dashboard answers:
  - `resume`: the ticket must be `stopped` and the note's reason not a cancel; start the pipeline as in `resumeSwitchedOff`; `requestDone(id, "done")`. Otherwise `requestDone(id, "refused")`.
  - `restart`: the ticket must be `stopped`; comment `Restarted from the dashboard by @<user>. This run ends as blocked and a new run starts.`, `setState("blocked")`, emit `run_end` `restarted` for the old run (through `ctx.dashboard.send` with the request's `run`), `setState("ready")`, `ci.start({ kind: "build", ticket })`, `requestDone(id, "done")`.
- Event step, `ready` path: when `tracker.startedBy(ticket)` is the factory itself, the actor is the `user` of a `restart` request for this ticket in `control(target).requests` done in the last 15 minutes; `trusted(actor)` is still checked. No such request: not trusted, as today.

- [ ] **Step 1: Write the failing tests**: resume request on a stopped ticket starts one build with the stopped pipeline and marks done; on a running ticket marks refused and starts nothing; restart gives `blocked` then `ready`, the comment, a new build, and that build's event step starts a run with a new run ID and actor `ana`; a `ready` set by the factory with no restart request does not start; the dashboard down: `handleRequests` does nothing and throws nothing.
- [ ] **Step 2: Run** `pnpm vitest run factory/steps`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm vitest run && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(control): resume and restart runs from the dashboard through the poller`.

---

## Part C: ops

### Task C1: Image, Compose, Caddy and the deploy job

**Files:**
- Create: `dashboard/Dockerfile` (multi-stage on `node:22-slim`: `pnpm install --frozen-lockfile --filter factory-dashboard...`, `next build`, run the standalone server as a non-root user; copies `targets/`), `deploy/compose.yml` (services `dashboard` with volume `/data` and an `.env` file, `caddy` with ports 80 and 443), `deploy/Caddyfile` (`{$DASHBOARD_HOST} { reverse_proxy dashboard:3000 }`). Setup steps go in `docs/setup.md` (Task C2)
- Modify: `.gitlab-ci.yml` (job `deploy-dashboard`), `factory/ci.test.ts`

**Interfaces:**
- `deploy-dashboard`: `tags: [factory]`, `image: node:22`, `rules: [{ if: '$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == "main"', changes: ["dashboard/**", "factory/run-events.ts", "deploy/**", "targets/**", "pnpm-lock.yaml"] }]`, `resource_group: dashboard-deploy`. Script: `ssh -i "$DASHBOARD_DEPLOY_KEY" -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$DASHBOARD_KNOWN_HOSTS" deploy@"$DASHBOARD_HOST" "cd /opt/software-factory && git fetch origin && git checkout --force $CI_COMMIT_SHA && docker compose -f deploy/compose.yml up -d --build"`. `DASHBOARD_DEPLOY_KEY` and `DASHBOARD_KNOWN_HOSTS` are File-type, protected; the VM clones with a read-only deploy token. The image is built on the VM, because factory runners have no Docker socket.
- The `.env` on the VM holds `FACTORY_DASHBOARD_TOKEN`, `GITLAB_*`, `GRAFANA_*`, `DASHBOARD_URL`, `FACTORY_PROJECT_ID`; it is never in git.

- [ ] **Step 1: Write the failing test** in `ci.test.ts`: `deploy-dashboard` runs only on a push to `main` with the changes list above, and its script has `StrictHostKeyChecking=yes`.
- [ ] **Step 2: Run** `pnpm vitest run factory/ci.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm vitest run factory/ci.test.ts`, then `docker compose -f deploy/compose.yml build` locally and `docker compose -f deploy/compose.yml up -d` with a test `.env`; `curl -k https://localhost/api/auth/login -o /dev/null -w '%{http_code}'`. Expected: PASS and `302`.
- [ ] **Step 5: Commit** `feat(deploy): deploy the dashboard with Docker Compose behind Caddy`.

---

### Task C2: Alloy on the runners, and docs

**Files:**
- Create: `deploy/alloy/runner.alloy` (Docker logs from `/var/lib/docker/containers`, journal for `gitlab-runner` and system, `prometheus.exporter.unix`; labels `job="factory-runner"`, `source`, `host`; push to Loki and to the metrics store at `ops.<domain>`)
- Modify: `runner/cloud-init.yml` (install Alloy at a pinned version, write the config, start it), `docs/setup.md` (new section "Dashboard": VM, DNS `factory.<domain>`, GitLab OAuth app with redirect `https://factory.<domain>/api/auth/callback` and scope `read_api`, the two GitLab tokens, the Grafana token, `FACTORY_DASHBOARD_TOKEN` as a File variable in the factory project and in the VM `.env`, the deploy key and known hosts, the Alloy push credential, Hetzner backups for the VM), `docs/how-it-works.md` (a short "Dashboard" section: what it shows, stop, resume, restart, switches, what happens when it is down; the labels table gets `factory_stopped` if Task 8 has not added it)

**Interfaces:**
- The Alloy push credential is write-only for Loki and metrics, lives on the VM host in `/etc/alloy/`, and is never mounted into a job container (the runner config mounts no host paths).

- [ ] **Step 1: Check** the config: `alloy fmt deploy/alloy/runner.alloy` exits 0.
- [ ] **Step 2: Real check (manual):** start one factory job; in Grafana Explore, `{job="factory-runner", source="docker"}` shows its lines, and the dashboard runner view shows the VM's disk and memory. Inside the job container, `ls /etc/alloy` fails.
- [ ] **Step 3: Commit** `docs(dashboard): ship runner logs with Alloy and document the dashboard setup`.

---

## Decisions made after the spec

The user confirmed or accepted each of these on 2026-10-29.

1. A metrics store exists at `ops.<domain>`. Alloy ships node metrics there, and the runner view shows disk and memory.
2. Two GitLab tokens for the dashboard: a read bot (`read_api`, Reporter on factory and targets) and a factory project access token (Developer, `api`) used only for cancel. [Two tokens, so a leak of the read token cannot write.]
3. Resume and restart wait for the poller. The poller schedule changes from every 5 minutes to every minute (`* * * * *`), so a request waits up to 1 minute. Task C2 changes the schedule in `docs/setup.md` and the poller text in `docs/how-it-works.md`.
4. A run ended by a pipeline cancel can only be restarted. [Yes.]
5. Restart trust: the event step accepts a factory-set `ready` when the dashboard confirms a restart for that ticket in the last 15 minutes. [Yes.]
6. Deploy builds the image on the dashboard VM over SSH. [Yes, factory runners have no Docker.]
7. Sign-in uses a maintained auth library, not hand-written OAuth (see Task A5).
