// Starting, pausing, picking up and ending a run (GLOSSARY.md: Run, Paused run, Resume, Stop, Restart).
// Each pause writes a note on the work item. The state label says which kind of note to read, the newest factory
// note of that kind names the pipeline whose run record to load, and the record decides the rest.
// A schedule (the poller, the hourly retry) only starts a pipeline. That pipeline's event step loads the record,
// checks it and continues: the event job runs one at a time per target, which keeps the run count safe.
import { randomUUID } from "node:crypto";
import { emit, emitFor, runIds, type RunIds } from "../emit";
import type { PausableStep } from "../record";
import { conversation, md, type Read } from "../conversation";
import { STEPS, SWITCHES, type ControlRequest } from "../run-events";
import type { ChangeRef, FactoryEvent, FactoryState, SwitchName, Ticket, TicketRef } from "../seams";
import type { FactoryCommands } from "../types";
import { startStep } from "./with-step";
import { controls, facts, person, save, ticketRef, type StepContext, type StepResult } from "./context";

export const MAX_RUNS_PER_REPO = 2;
// A ticket in one of these states already has a run. needs_info, blocked and done do not.
export const ACTIVE_STATES: FactoryState[] = ["running", "waiting", "stopped", "needs_approval"];

export type StartDecision = { start: true } | { start: false; reason: "not-added" | "not-ready" | "not-member" | "active-run" | "repo-full" };

// Caller contract:
// (a) handle one ticket at a time (the event job runs in a CI resource_group per target, which also guards the run count);
// (b) pass the state read live from the tracker, not from the event;
// (c) set the running state before handling the next event;
// (d) runningInRepo is the number of OTHER active runs in the repo, not counting this ticket.
export function decideStart(e: FactoryEvent, ctx: { actorTrusted: boolean; state?: FactoryState; runningInRepo: number }): StartDecision {
  if (e.kind !== "ready") return { start: false, reason: "not-added" };
  const active = ctx.state !== undefined && ACTIVE_STATES.includes(ctx.state);
  // The event may be old: someone may have taken the ready state off since.
  if (ctx.state !== "ready" && !active) return { start: false, reason: "not-ready" };
  if (!ctx.actorTrusted) return { start: false, reason: "not-member" };
  if (active) return { start: false, reason: "active-run" };
  if (ctx.runningInRepo >= MAX_RUNS_PER_REPO) return { start: false, reason: "repo-full" };
  return { start: true };
}

// Tickets in the repo that hold a run slot.
export async function activeRuns(ctx: StepContext): Promise<number> {
  const lists = await Promise.all(ACTIVE_STATES.map((s) => ctx.tracker.list(s)));
  return lists.reduce((n, l) => n + l.length, 0);
}
// How long a dashboard restart owns the ready the factory set for it (readyActor).
export const RESTART_MS = 15 * 60_000;

// May this person's ready start a run? A trusted person may. The factory may only for the watcher's own
// tickets, which it opens ready. trusted() stays false for the factory, so it still cannot command.
export async function mayStart(ctx: StepContext, actor: string, ticket: Ticket): Promise<boolean> {
  if (actor === "") return false;
  if (await ctx.tracker.trusted(actor)) return true;
  return ticket.marks.includes("watcher") && (await ctx.tracker.isFactory(actor));
}

// Who set the ticket ready. A ready the factory set in the last 15 minutes is the person's it set it for: a dashboard
// restart of this ticket, pending or done, else the newest `@factory` request its comment names. mayStart still checks that person.
// `restart`: a dashboard restart, which starts a new run instead of continuing a blocked one.
export async function readyActor(ctx: StepContext, ref: TicketRef, actor: string): Promise<{ actor: string; restart: boolean }> {
  if (!(await ctx.tracker.isFactory(actor))) return { actor, restart: false };
  const control = await controls(ctx);
  const recent = (at: string) => Date.now() - Date.parse(at) >= 0 && Date.now() - Date.parse(at) <= RESTART_MS; // a future or bad `at` never counts
  const restart = control.requests.find((r) => r.kind === "restart" && r.ticket === ref && (!r.outcome || r.outcome === "done") && recent(r.at));
  if (restart) return { actor: restart.user, restart: true };
  // A dashboard Set to Ready the poller did: the person who pressed it set the ticket ready.
  const ready = control.requests.find((r) => r.kind === "ready" && r.ticket === ref && r.outcome === "done" && recent(r.at));
  if (ready) return { actor: ready.user, restart: false };
  const asked = await conversation(ctx).newest(ref, "readyFor");
  return { actor: asked && recent(asked.at) ? asked.person : actor, restart: false };
}

// A new run gets its ID here, then the event step's start (runStep leaves it to that step).
export async function startRun(ctx: StepContext, ref: TicketRef): Promise<StepResult> {
  ctx.record = { ...ctx.record, runId: randomUUID() };
  emit(ctx, "run_start", {});
  startStep(ctx);
  await ctx.tracker.setState(ref, "running");
  return "next";
}

// The only place run_end is sent. A waiting or stopped run has not ended: the dashboard refuses
// Stop, Resume and Restart once it saw run_end. ids: another run's IDs, for the poller's restart.
export function endRun(ctx: StepContext, outcome: "done" | "blocked" | "needs_info" | "restarted" | "closed", ids: RunIds = runIds(ctx)): void {
  emitFor(ids, ctx, "run_end", { outcome });
}

// The build pipeline, then the finish pipeline from apply on.
export { STEPS };
// Plain strings: callers ask with CI job names, which are not all run steps.
export const BUILD_STEPS: readonly string[] = STEPS.slice(0, STEPS.indexOf("apply"));
export const FINISH_STEPS: readonly string[] = STEPS.slice(STEPS.indexOf("apply"));
// A ready on a blocked ticket continues the run at one of these jobs. A block anywhere else starts a new run.
const CONTINUABLE = BUILD_STEPS.slice(2);

// A resumed run skips the build jobs that finished before the one it continues at.
export function doneBeforeResume(ctx: StepContext, name: string): boolean {
  const i = BUILD_STEPS.indexOf(name);
  return i > 0 && i < BUILD_STEPS.indexOf(facts(ctx).resumeAt ?? "");
}

// Stop the run for a person: state, comment, assign, notice.
// continuable false: this pipeline fails, so its record never uploads and the comment names no run.
export async function block(ctx: StepContext, reason: string, continuable = CONTINUABLE.includes(ctx.job ?? ctx.step ?? "")): Promise<StepResult> {
  const ref = ticketRef(ctx);
  const t = await ctx.tracker.ticket(ref);
  save(ctx, "blocked", { reason, step: ctx.job ?? ctx.step });
  if (!t.open) await ctx.tracker.reopen(ref); // the change closed it at the merge
  await ctx.tracker.setState(ref, "blocked");
  endRun(ctx, "blocked");
  await conversation(ctx).write(ref, { kind: "blocked", reason, ...(continuable ? { run: ctx.ci.vars.run ?? "unknown" } : {}) });
  await ctx.tracker.assign(ref, person(ctx, t));
  await ctx.chat.notify("blocked", t.title, [reason], t.url);
  return "stop";
}

// The agent hit a usage limit: keep the session so a later run can resume it. The hourly retry reads the note.
export async function waiting(ctx: StepContext, step: PausableStep, sessionId: string, extra: { commands?: FactoryCommands } = {}): Promise<StepResult> {
  const ref = ticketRef(ctx);
  save(ctx, step, { ...extra, sessionId, limit: true });
  await ctx.tracker.setState(ref, "waiting");
  await conversation(ctx).write(ref, { kind: "waiting", run: ctx.ci.vars.run });
  return "stop";
}

// A person (`@factory stop`) or a dashboard switch stopped the run. A stop the inbox saw because a person closed
// the work item or the change ends the run here instead.
export async function stopped(ctx: StepContext, step: PausableStep, o: { session?: string; reason: string; change?: ChangeRef; extra?: { commands?: FactoryCommands } }): Promise<StepResult> {
  // A failed host read must not turn a person's stop into a step error: the stop goes on.
  const end = await endIfClosed(ctx).catch((e) => void console.log(`Closed check before the stop failed: ${String(e).slice(0, 300)}`));
  if (end) return end;
  const ref = ticketRef(ctx);
  save(ctx, step, { ...o.extra, sessionId: o.session, stopped: true, switchOff: o.reason.startsWith("switch off") });
  await ctx.tracker.setState(ref, "stopped");
  await conversation(ctx).write(ref, { kind: "stopped", run: ctx.ci.vars.run ?? "unknown", step, reason: o.reason, change: o.change, buildRun: ctx.ci.vars.buildRun });
  return "stop";
}
// Part C (GLOSSARY.md: Closed run). What a person closed, read live when the caller acts: a webhook may have seen the
// work item closed and then opened again. The factory closes the ticket itself (the change's closing line at its merge,
// then result-saved), so only a ticket in one of `states` counts, and never one whose own change merged.
// ours: the change belongs to this run. An older run's change stays the newest on the branch until this run pushes.
type Closed = { ticket: true; change?: { ref: ChangeRef; open: boolean } } | { ticket: false; url: string };
async function closedNow(ctx: StepContext, ref: TicketRef, states: FactoryState[], ours: (t: Ticket, c: ChangeRef) => boolean | Promise<boolean>): Promise<Closed | undefined> {
  const t = await ctx.tracker.ticket(ref);
  if (!t.state || !states.includes(t.state)) return undefined;
  const c = await ctx.codeHost.changeOfTicket(ref);
  if (c?.merged && (await ours(t, c.ref))) return undefined; // an older run's merged change does not shield this run
  if (!t.open) return { ticket: true, change: c };
  if (c && !c.open && (await ours(t, c.ref))) return { ticket: false, url: c.url };
  return undefined;
}

// A closed work item ends the run quietly: its open change is closed, then its state is removed. A change closed
// without a merge, while the work item is open, blocks the run. ctx: the ticket's own context (ticketRef).
async function endClosed(ctx: StepContext, ref: TicketRef, closed: Closed): Promise<StepResult> {
  if (!closed.ticket) return block(ctx, `The merge request ${closed.url} was closed without a merge.`, false);
  if (closed.change?.open) {
    await ctx.codeHost.commentChange(closed.change.ref, md("🚫", "Change closed", `This merge request was closed because a person closed work item #${ref}.`));
    await ctx.codeHost.closeChange(closed.change.ref);
  }
  await ctx.tracker.clearState(ref);
  endRun(ctx, "closed");
  return "stop";
}

// In a step the run's change is the one its record names. Before the gate's push the run has none.
const ownChange = (ctx: StepContext) => (_t: Ticket, c: ChangeRef) => c === facts(ctx).change;
// For the inbox: did a person close the work item or this run's change?
export const closedByPerson = async (ctx: StepContext): Promise<boolean> => (await closedNow(ctx, ticketRef(ctx), ACTIVE_STATES, ownChange(ctx))) !== undefined;

// Before a step writes: end the run if a person closed its work item or its change. Undefined: go on.
export async function endIfClosed(ctx: StepContext): Promise<StepResult | undefined> {
  const ref = ticketRef(ctx);
  const closed = await closedNow(ctx, ref, ACTIVE_STATES, ownChange(ctx));
  return closed && endClosed(ctx, ref, closed);
}

// The runs with no step running. A running run's own steps check for itself.
const PAUSED: FactoryState[] = ["needs_approval", "waiting", "stopped"];
// The poller has no run record. A ticket is past the gate's push when it waits for a person,
// or a stop note names the decision or apply step. Before the push, the newest change is an older run's.
const pushed = async (ctx: StepContext, t: Ticket) => {
  const note = t.state === "stopped" ? await conversation(ctx).newest(t.ref, "stopped") : undefined;
  return t.state === "needs_approval" || (note?.kind === "stopped" && ["decision", "apply"].includes(note.step ?? ""));
};

// The poller: a paused run whose work item or change a person closed would keep its run slot for good. Same outcomes
// as endIfClosed. Returns the tickets it ended. One failed ticket is logged and tried again next minute.
export async function endClosedRuns(ctx: StepContext): Promise<TicketRef[]> {
  const closed = (await ctx.tracker.listClosed(100)).filter((t) => t.state && PAUSED.includes(t.state));
  const open = (await Promise.all(PAUSED.map((s) => ctx.tracker.list(s)))).flat();
  const ended: TicketRef[] = [];
  for (const { ref } of [...closed, ...open]) {
    try {
      const one = { ...ctx, ci: { ...ctx.ci, vars: { ...ctx.ci.vars, ticket: ref } } };
      const c = await closedNow(one, ref, PAUSED, (t) => pushed(ctx, t));
      if (!c) continue;
      await endClosed(one, ref, c);
      ended.push(ref);
    } catch (e) {
      console.log(`Ending closed ticket ${ref} failed: ${String(e).slice(0, 300)}`);
    }
  }
  return ended;
}

const PERSON_STOP = "stopped by @factory stop";
const DASHBOARD_STOP = "stopped from the dashboard";
// Why the inbox stopped the run: the dashboard, or else a person's `@factory stop`.
export const stopReason = (ctx: StepContext) => (ctx.dashboardStop ? DASHBOARD_STOP : PERSON_STOP);

// Starts a stopped run again, in the kind of pipeline it stopped in. A build run resumes through its event step,
// which checks the ticket and the record again. False when the note does not say enough to start it
// (an old note names no step, a note at apply no change or build pipeline).
async function startStopped(ctx: StepContext, ref: TicketRef, note: Extract<Read<"stopped">, { kind: "stopped" }>): Promise<boolean> {
  if (!note.step) return false;
  if (note.step !== "apply") {
    await ctx.ci.start({ kind: "build", ticket: ref, buildRun: note.run });
    return true;
  }
  if (!note.change || !/^\d+$/.test(note.buildRun ?? "")) return false;
  // Also a guard against a second start by the next poll. Apply sets "running" again through its run, for the dashboard.
  await ctx.tracker.setState(ref, "running");
  try {
    await ctx.ci.start({ kind: "finish", ticket: ref, change: note.change, buildRun: note.buildRun });
  } catch (e) {
    await ctx.tracker.setState(ref, "stopped"); // the next try starts it
    throw e;
  }
  return true;
}

// Where the loaded record of buildRun continues for this work item, or why it cannot. A paused (waiting or stopped)
// run continues at the step that paused, with its session; a blocked run at the job that blocked.
function continuePoint(ctx: StepContext, ref: TicketRef, buildRun: string, kind: "paused" | "blocked"): { at: string; sessionId?: string } | { why: string } {
  const f = facts(ctx);
  const why = f.cannotContinue(`${ctx.target.projectPath}#${ref}`, buildRun);
  if (why) return { why };
  if (kind === "blocked") return f.blockedStep && CONTINUABLE.includes(f.blockedStep) ? { at: f.blockedStep } : { why: `the record of pipeline ${buildRun} does not show which step blocked` };
  const p = f.paused;
  // A run a switch stopped has no session: that step starts afresh.
  if (!p || !(p.sessionId || p.switchOff)) return { why: `the record of pipeline ${buildRun} has no saved session` };
  // The questions agent runs inside the triage job.
  return { at: p.step === "questions" ? "triage" : p.step, sessionId: p.sessionId };
}

// Continue the loaded run: the build jobs before resumeAt skip.
// `round`: a request round starts here; the dashboard hears which one.
export async function continueAt(ctx: StepContext, ref: TicketRef, resumeAt: string, d: { actor?: string; fromPipeline: string; sessionId?: string; round?: number }): Promise<StepResult> {
  save(ctx, "event", { start: true, resume: true, ticket: ref, resumeAt, ...d });
  startStep(ctx, d.round ? { round: d.round } : {});
  await ctx.tracker.setState(ref, "running");
  return "next";
}

// The event step of a pipeline a schedule or a resume started for a waiting or stopped run. The record is loaded
// already, through the provenance-checked loader. Never start over silently.
export async function resume(ctx: StepContext, ref: TicketRef, buildRun: string): Promise<StepResult> {
  const quiet = (reason: string) => (save(ctx, "event", { start: false, reason, ticket: ref }), "stop" as const);
  const state = (await ctx.tracker.ticket(ref)).state;
  if (state !== "waiting" && state !== "stopped") return quiet("not-waiting");
  const c = continuePoint(ctx, ref, buildRun, "paused");
  if ("why" in c) return block(ctx, `The factory could not resume this run: ${c.why}. Add factory_ready to start again.`);
  // This ticket is waiting, so it is one of the active runs already.
  if ((await activeRuns(ctx)) - 1 >= MAX_RUNS_PER_REPO) return quiet("repo-full");
  await ctx.ci.restoreRun(buildRun);
  return continueAt(ctx, ref, c.at, { fromPipeline: buildRun, sessionId: c.sessionId });
}

// A trusted person's `@factory resume` on a stopped ticket (the caller checked both). It continues the run named in the
// factory's newest stop note, a finish run the apply switch stopped as a finish run.
export async function resumeOnCommand(ctx: StepContext, ref: TicketRef, actor: string, quiet: (reason: string) => "stop"): Promise<StepResult> {
  const note = await conversation(ctx).newest(ref, "stopped");
  // A cancelled pipeline saved nothing after the stop before it: only a restart helps.
  if (note?.kind === "cancelled") return quiet("cancelled");
  if (note?.kind === "stopped" && note.step === "apply") {
    if (!(await startStopped(ctx, ref, note))) return block(ctx, "The factory could not resume this run: its stopped-run comment names no change or build pipeline. Add factory_ready to start again.");
    save(ctx, "event", { start: true, resume: true, ticket: ref, actor, change: note.change, fromPipeline: note.buildRun });
    return "stop";
  }
  const buildRun = note?.run;
  if (!buildRun) {
    quiet("no-stopped-run");
    return block(ctx, "The factory could not resume this run: it found no stopped-run comment from the factory. Add factory_ready to start again.");
  }
  try {
    ctx.record = await ctx.ci.buildRecord(buildRun);
  } catch (err) {
    quiet("record-unavailable");
    return block(ctx, `The factory could not resume this run: the record of pipeline ${buildRun} could not be loaded (${String(err).slice(0, 300)}). Add factory_ready to start again.`);
  }
  return resume(ctx, ref, buildRun);
}

// A person set a blocked ticket ready again: continue the run at the job that blocked. Undefined: start a new run.
export async function continueBlocked(ctx: StepContext, e: Extract<FactoryEvent, { kind: "ready" }>): Promise<StepResult | undefined> {
  const buildRun = (await conversation(ctx).newest(e.ticket, "blocked"))?.run;
  if (!buildRun) return undefined;
  const fresh = ctx.record;
  let c: ReturnType<typeof continuePoint>;
  try {
    ctx.record = await ctx.ci.buildRecord(buildRun);
    c = continuePoint(ctx, e.ticket, buildRun, "blocked");
  } catch (err) {
    c = { why: `the record of pipeline ${buildRun} could not be loaded (${String(err).slice(0, 300)})` };
  }
  if ("why" in c) {
    ctx.record = fresh;
    await ctx.tracker.comment(e.ticket, md("🔄", "New run", `The factory starts a new run, because it cannot continue the blocked run.`, `**Why:** ${c.why}.`));
    return undefined;
  }
  // The blocked job starts its rounds again. The gate job runs code review too.
  if (c.at === "code-review" || c.at === "precommit-gate") ctx.record = { ...ctx.record, rounds: { review: 0, gate: 0 } };
  // prepare-patch starts on a fresh clone, so a half-done edit never picks the .factory.yml commands.
  if (c.at !== "prepare-patch") await ctx.ci.restoreRun(buildRun);
  return continueAt(ctx, e.ticket, c.at, { actor: e.actor, fromPipeline: buildRun });
}

// The poller: a run a dashboard switch stopped goes on once that switch is on again, in the same kind of pipeline it stopped in.
export async function resumeSwitchedOff(ctx: StepContext, skip: TicketRef[] = []): Promise<TicketRef[]> {
  // Unlike a running step, a resume needs the dashboard: a switch someone turned off must not count as on (controls()).
  const control = await controls(ctx);
  if (!SWITCHES.some((n) => control.resumeOn(n))) return []; // also while the dashboard cannot be reached
  const started: TicketRef[] = [];
  for (const { ref } of await ctx.tracker.list("stopped")) {
    if (skip.includes(ref)) continue;
    const note = await conversation(ctx).newest(ref, "stopped");
    const name = note?.kind === "stopped" && note.reason && /^switch off (\w+)$/.exec(note.reason)?.[1];
    if (note?.kind !== "stopped" || !name || !control.resumeOn(name as SwitchName)) continue;
    if (await startStopped(ctx, ref, note)) started.push(ref);
  }
  return started;
}

// The poller: the dashboard cancelled a pipeline that did not stop in time. That run saved nothing, so the ticket is
// marked stopped with a note that it can only be restarted. Then the dashboard hears the request is done.
export async function finishCancelledStops(ctx: StepContext): Promise<TicketRef[]> {
  const control = await controls(ctx);
  const finished: TicketRef[] = [];
  for (const r of control.requests) {
    if (r.kind !== "stop" || r.outcome !== "cancelled") continue;
    // One failed request must not stop the poller: it is logged and tried again next minute.
    try {
      const t = await ctx.tracker.ticket(r.ticket).catch((e) => {
        if (/status 404|No ticket/.test(String(e))) return undefined; // the ticket is gone, nothing to stop
        throw e;
      });
      if (t?.state === "running") {
        // The comment first: without it a resume would read an older stop note.
        await conversation(ctx).write(r.ticket, { kind: "cancelled", user: r.user });
        await ctx.tracker.setState(r.ticket, "stopped");
        finished.push(r.ticket);
      }
      await ctx.dashboard.requestDone(r.id, "done");
    } catch (e) {
      console.log(`Request ${r.id} (cancelled stop of ticket ${r.ticket}) failed: ${String(e).slice(0, 300)}`);
    }
  }
  return finished;
}

// The poller: resume and restart requests from the dashboard. The dashboard checked the person's role; this checks the ticket.
// Returns the tickets it started. A failed request stays pending for the next poll and does not stop the others.
export async function handleRequests(ctx: StepContext): Promise<TicketRef[]> {
  const control = await controls(ctx);
  const started: TicketRef[] = [];
  for (const r of control.requests) {
    if (r.outcome || (r.kind !== "resume" && r.kind !== "restart")) continue;
    try {
      const t = await ctx.tracker.ticket(r.ticket).catch((e) => {
        if (/status 404|No ticket/.test(String(e))) return undefined; // the ticket is gone
        throw e;
      });
      // A restart whose start failed set the ticket ready already: only the start is left.
      const retry = r.kind === "restart" && t?.state === "ready" && (await ctx.tracker.isFactory((await ctx.tracker.startedBy(r.ticket)) ?? ""));
      const ok = retry ? await retryRestart(ctx, r) : t?.state === "stopped" && (r.kind === "resume" ? await resumeRequest(ctx, r) : await restart(ctx, r));
      if (ok) started.push(r.ticket);
      await ctx.dashboard.requestDone(r.id, ok ? "done" : "refused");
    } catch (e) {
      console.log(`Request ${r.id} (${r.kind} of ticket ${r.ticket}) failed: ${String(e).slice(0, 300)}`);
    }
  }
  return started;
}

// The poller: dashboard Set to Ready. The factory sets the label for a person the target trusts, as the Ready they
// would set themselves. It starts nothing, so the local factory's --list poll runs it too; the ready ticket then
// starts like any other (pollReady, the webhook). Returns the tickets it set ready.
export async function handleReadyRequests(ctx: StepContext): Promise<TicketRef[]> {
  const set: TicketRef[] = [];
  for (const r of (await controls(ctx)).requests) {
    if (r.outcome || r.kind !== "ready") continue;
    try {
      const state = (await ctx.tracker.ticket(r.ticket).catch((e) => {
        if (/status 404|No ticket/.test(String(e))) return undefined; // the ticket is gone
        throw e;
      }))?.state;
      const ok = (state === "blocked" || state === "needs_info") && (await ctx.tracker.trusted(r.user));
      if (ok) {
        await ctx.tracker.comment(r.ticket, md("▶️", "Set to Ready", `@${r.user} set the work item to Ready from the dashboard.`));
        await ctx.tracker.setState(r.ticket, "ready");
        set.push(r.ticket);
      }
      await ctx.dashboard.requestDone(r.id, ok ? "done" : "refused");
    } catch (e) {
      console.error(`Request ${r.id} (ready of ticket ${r.ticket}) failed: ${String(e).slice(0, 300)}`); // stderr: --list prints only ticket refs on stdout
    }
  }
  return set;
}

// A cancelled pipeline saved nothing after the stop before it, so only a restart helps.
// The dashboard checked the role on the factory project; the target project must trust the person too (Ruling R45).
async function resumeRequest(ctx: StepContext, r: ControlRequest): Promise<boolean> {
  if (!(await ctx.tracker.trusted(r.user))) return false;
  const note = await conversation(ctx).newest(r.ticket, "stopped");
  return note?.kind === "stopped" && startStopped(ctx, r.ticket, note);
}

// The old run ends as blocked and the ticket is ready again. The new build's event step takes the factory's ready
// as the request user's (readyActor), so it gets a new run ID.
async function restart(ctx: StepContext, r: ControlRequest): Promise<boolean> {
  await ctx.tracker.comment(r.ticket, md("🔄", "Restarted", `@${r.user} restarted the run from the dashboard. This run ends as blocked and a new run starts.`));
  await ctx.tracker.setState(r.ticket, "blocked");
  await ctx.tracker.setState(r.ticket, "ready");
  return startRestart(ctx, r);
}

// Past RESTART_MS the event step no longer takes the factory's ready as the person's, so the ticket goes back
// to stopped rather than wait as a ready nobody can start (Ruling R47). The same window as readyActor.
async function retryRestart(ctx: StepContext, r: ControlRequest): Promise<boolean> {
  const age = Date.now() - Date.parse(r.at);
  if (age >= 0 && age <= RESTART_MS) return startRestart(ctx, r);
  await ctx.tracker.comment(r.ticket, md("⚠️", "Restart failed", "The restart could not start a new run within 15 minutes. The ticket is stopped again. Press **Restart** on the dashboard to try again."));
  await ctx.tracker.setState(r.ticket, "stopped");
  return false;
}

async function startRestart(ctx: StepContext, r: ControlRequest): Promise<boolean> {
  const url = await ctx.ci.start({ kind: "build", ticket: r.ticket });
  // Only once the new run is on its way. The old run's event names its own ticket and no poller pipeline or job.
  endRun(ctx, "restarted", { ...runIds(ctx), run: r.run, ticket: r.ticket, pipeline: undefined, job: undefined });
  // The new run is started: a failure here must not leave the request pending, or the next poll starts a second run.
  await closeStoppedChange(ctx, r, url).catch((e) => console.log(`Closing the change of ticket ${r.ticket} failed: ${String(e).slice(0, 300)}`));
  return true;
}

// A run stopped at apply left its change open. The new run opens its own, so the old one is closed.
// The ticket is ready by now, but the stopped note still names the change.
async function closeStoppedChange(ctx: StepContext, r: ControlRequest, url: string): Promise<void> {
  const note = await conversation(ctx).newest(r.ticket, "stopped");
  const change = note?.kind === "stopped" ? note.change : undefined;
  if (!change || !(await ctx.codeHost.change(change)).open) return;
  await ctx.codeHost.commentChange(change, md("🚫", "Change closed", `This change was closed because @${r.user} restarted the run from the dashboard.`, url && `**New run:** ${url}`));
  await ctx.codeHost.closeChange(change);
}
