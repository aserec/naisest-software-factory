// Starting, pausing, picking up and ending a run (GLOSSARY.md: Run, Paused run, Resume, Stop, Restart).
// Each pause writes a note on the work item. The state label says which kind of note to read, the newest factory
// note of that kind names the pipeline whose run record to load, and the record decides the rest.
// A schedule (the poller, the hourly retry) only starts a pipeline. That pipeline's event step loads the record,
// checks it and continues: the event job runs one at a time per target, which keeps the run count safe.
import { randomUUID } from "node:crypto";
import { emit, emitFor, runIds, type RunIds } from "../emit";
import type { PausableStep } from "../record";
import { conversation, md, type Read } from "../conversation";
import { errText } from "../errors";
import { STOP_COMMAND } from "../inbox-file";
import { STEPS } from "../run-events";
import type { ChangeRef, FactoryEvent, FactoryState, PersonRef, Ticket, TicketRef } from "../seams";
import type { FactoryCommands } from "../types";
import { startStep } from "./with-step";
import { NEXT, ENDED, controls, facts, person, save, ticketRef, type StepContext, type StepOutcome } from "./context";

export const MAX_RUNS_PER_REPO = 2;
// A target's own limit (targets/<name>.yml maxRuns): one whose runs share a fixed port must run alone.
export const maxRuns = (ctx: Pick<StepContext, "target">): number => ctx.target.maxRuns ?? MAX_RUNS_PER_REPO;
// A ticket in one of these states already has a run. needs_info, blocked and done do not.
export const ACTIVE_STATES: FactoryState[] = ["running", "waiting", "stopped", "needs_approval"];

export type StartDecision = { start: true } | { start: false; reason: "not-added" | "not-ready" | "not-member" | "active-run" | "repo-full" | "blocked-by" | "epic" };

// Caller contract:
// (a) handle one ticket at a time (the event job runs in a CI resource_group per target, which also guards the run count);
// (b) pass the state read live from the tracker, not from the event;
// (c) set the running state before handling the next event;
// (d) runningInRepo is the number of OTHER active runs in the repo, not counting this ticket.
export function decideStart(e: FactoryEvent, ctx: { actorTrusted: boolean; state?: FactoryState; runningInRepo: number; maxRuns?: number; openBlockers?: number; epic?: boolean }): StartDecision {
  if (e.kind !== "ready") return { start: false, reason: "not-added" };
  if (ctx.epic) return { start: false, reason: "epic" }; // an epic's sub-tickets are the work, also when the epic is ready
  const active = ctx.state !== undefined && ACTIVE_STATES.includes(ctx.state);
  // The event may be old: someone may have taken the ready state off since.
  if (ctx.state !== "ready" && !active) return { start: false, reason: "not-ready" };
  if (!ctx.actorTrusted) return { start: false, reason: "not-member" };
  if (active) return { start: false, reason: "active-run" };
  if (ctx.runningInRepo >= (ctx.maxRuns ?? MAX_RUNS_PER_REPO)) return { start: false, reason: "repo-full" };
  // A ticket blocked by another waits until that one is merged and closed: its patch would build on code main does not have yet.
  if (ctx.openBlockers) return { start: false, reason: "blocked-by" };
  return { start: true };
}

// Tickets in the repo that hold a run slot. needs_approval does not: the factory's work is done, and a person's change request sets it ready again.
export async function activeRuns(ctx: StepContext): Promise<number> {
  const lists = await Promise.all(ACTIVE_STATES.filter((s) => s !== "needs_approval").map((s) => ctx.tracker.list(s)));
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
export async function startRun(ctx: StepContext, ref: TicketRef): Promise<StepOutcome> {
  ctx.record = { ...ctx.record, runId: randomUUID() };
  emit(ctx, "run_start", {});
  startStep(ctx);
  await ctx.tracker.setState(ref, "running");
  return NEXT;
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
export const CONTINUABLE = BUILD_STEPS.slice(2);
const CODE_STEPS: readonly string[] = STEPS.slice(STEPS.indexOf("prepare-patch"));

// A resumed run skips the build jobs that finished before the one it continues at.
export function doneBeforeResume(ctx: StepContext, name: string): boolean {
  const i = BUILD_STEPS.indexOf(name);
  return i > 0 && i < BUILD_STEPS.indexOf(facts(ctx).resumeAt ?? "");
}

// The outcomes a step returns to pause or block its run. applyOutcome makes their writes.
// continuable false: this pipeline fails, so its record never uploads and the comment names no run.
// Without continuable, a block can continue when its job can (CONTINUABLE).
export const block = (reason: string, o: { continuable?: boolean } = {}): StepOutcome => ({ kind: "blocked", reason, ...o });
// The agent hit a usage limit: keep the session so a later run can resume it.
export const waiting = (step: PausableStep, session: string, commands?: FactoryCommands): StepOutcome => ({ kind: "waiting", step, session, commands });
// The network stayed down through every try: the hourly retry runs the step again, with the run's newest session.
export const networkWaiting = (step: PausableStep, session?: string): StepOutcome => ({ kind: "waiting", step, session, network: true });
// A person (`@factory stop`) or a dashboard switch stopped the run.
export const stopped = (step: PausableStep, o: { session?: string; reason: string; change?: ChangeRef; commands?: FactoryCommands }): StepOutcome => ({ kind: "stopped", step, ...o });

// GLOSSARY.md: Step outcome. The one place a run halts: runStep applies what each step returns, and the schedules
// apply what they build. Gives back the outcome it applied: a stop on a closed work item ends the run as closed.
export async function applyOutcome(ctx: StepContext, o: StepOutcome): Promise<StepOutcome> {
  switch (o.kind) {
    case "next":
    case "ended":
      return o;
    case "blocked":
      await applyBlock(ctx, o.reason, o.continuable ?? CONTINUABLE.includes(ctx.job ?? ctx.step ?? ""));
      return o;
    case "waiting": {
      // The hourly retry reads the note.
      const ref = ticketRef(ctx);
      save(ctx, o.step, { ...(o.commands && { commands: o.commands }), sessionId: o.session, limit: true, ...(o.network && { network: true as const }) });
      await ctx.tracker.setState(ref, "waiting");
      await conversation(ctx).write(ref, { kind: "waiting", run: ctx.ci.vars.run, ...(o.network && { network: true as const }) });
      return o;
    }
    case "stopped": {
      // A stop the inbox saw because a person closed the work item or the change ends the run as closed instead.
      // A failed host read must not turn a person's stop into a step error: the stop goes on.
      const end = await closedOutcome(ctx).catch((e) => void console.log(`Closed check before the stop failed: ${errText(e)}`));
      if (end) return applyOutcome(ctx, end);
      const ref = ticketRef(ctx);
      save(ctx, o.step, { ...(o.commands && { commands: o.commands }), sessionId: o.session, stopped: true, switchOff: o.reason.startsWith("switch off") });
      await ctx.tracker.setState(ref, "stopped");
      await conversation(ctx).write(ref, { kind: "stopped", run: ctx.ci.vars.run ?? "unknown", step: o.step, reason: o.reason, change: o.change, buildRun: ctx.ci.vars.buildRun });
      return o;
    }
    case "closed":
      return endClosed(ctx, o.ref, o.closed);
  }
}

// Stop the run for a person: state, comment, assign, notice.
async function applyBlock(ctx: StepContext, reason: string, continuable: boolean): Promise<void> {
  const ref = ticketRef(ctx);
  const t = await ctx.tracker.ticket(ref);
  save(ctx, "blocked", { reason, step: ctx.job ?? ctx.step });
  if (!t.open) await ctx.tracker.reopen(ref); // the change closed it at the merge
  await ctx.tracker.setState(ref, "blocked");
  endRun(ctx, "blocked");
  await conversation(ctx).write(ref, { kind: "blocked", reason, ...(continuable ? { run: ctx.ci.vars.run ?? "unknown" } : {}) });
  // A block about the code goes on the open change too, where people read the code. No run line there: continuing stays on the work item.
  if (CODE_STEPS.includes(ctx.job ?? ctx.step ?? "")) {
    const change = await ctx.codeHost.changeOfTicket(ref);
    if (change?.open) await conversation(ctx).writeOnChange(change.ref, { kind: "blocked", reason });
  }
  await ctx.tracker.assign(ref, person(ctx, t));
  await ctx.chat.notify("blocked", t.title, [reason], t.url);
}

// GLOSSARY.md: Closed run. What a person closed, read live when the caller acts: a webhook may have seen the
// work item closed and then opened again. The factory closes the ticket itself (the change's closing line at its merge,
// then result-saved), so only a ticket in one of `states` counts, and never one whose own change merged.
// isRunsChange: the change belongs to this run. An older run's change stays the newest on the branch until this run pushes.
export type Closed = { ticket: true; change?: { ref: ChangeRef; open: boolean } } | { ticket: false; url: string; closedBy?: PersonRef };
export async function closedNow(ctx: StepContext, ref: TicketRef, states: FactoryState[], isRunsChange: (t: Ticket, c: ChangeRef) => boolean | Promise<boolean>): Promise<Closed | undefined> {
  const t = await ctx.tracker.ticket(ref);
  if (!t.state || !states.includes(t.state)) return undefined;
  const change = await ctx.codeHost.changeOfTicket(ref);
  if (change?.merged && (await isRunsChange(t, change.ref))) return undefined; // an older run's merged change does not shield this run
  if (!t.open) return { ticket: true, change };
  if (change && !change.open && (await isRunsChange(t, change.ref))) return { ticket: false, url: change.url, closedBy: (await ctx.codeHost.change(change.ref)).closedBy };
  return undefined;
}

// A closed work item ends the run quietly: its open change is closed, then its state is removed. A change closed
// without a merge, while the work item is open, blocks the run. ctx: the ticket's own context (ticketRef).
async function endClosed(ctx: StepContext, ref: TicketRef, closed: Closed): Promise<StepOutcome> {
  if (!closed.ticket) return applyOutcome(ctx, block(`The merge request ${closed.url} was closed without a merge${closed.closedBy ? ` by ${closed.closedBy}` : ""}.`, { continuable: false }));
  if (closed.change?.open) {
    await ctx.codeHost.commentChange(closed.change.ref, md("🚫", "Change closed", `This merge request was closed because a person closed work item #${ref}.`));
    await ctx.codeHost.closeChange(closed.change.ref);
  }
  await ctx.tracker.clearState(ref);
  endRun(ctx, "closed");
  return { kind: "closed", ref, closed };
}

// In a step the run's change is the one its record names. Before the gate's push the run has none.
const ownChange = (ctx: StepContext) => (_t: Ticket, c: ChangeRef) => c === facts(ctx).change;
// For the inbox: did a person close the work item or this run's change?
export const closedByPerson = async (ctx: StepContext): Promise<boolean> => (await closedNow(ctx, ticketRef(ctx), ACTIVE_STATES, ownChange(ctx))) !== undefined;

// Before a step writes: the closed outcome if a person closed its work item or its change. Undefined: go on.
export async function closedOutcome(ctx: StepContext): Promise<StepOutcome | undefined> {
  const ref = ticketRef(ctx);
  const closed = await closedNow(ctx, ref, ACTIVE_STATES, ownChange(ctx));
  return closed && { kind: "closed", ref, closed };
}


const PERSON_STOP = `stopped by ${STOP_COMMAND}`;
const DASHBOARD_STOP = "stopped from the dashboard";
// Why the inbox stopped the run: the dashboard, or else a person's `@factory stop`.
export const stopReason = (ctx: StepContext) => (ctx.dashboardStop ? DASHBOARD_STOP : PERSON_STOP);

// Starts a stopped run again, in the kind of pipeline it stopped in. A build run resumes through its event step,
// which checks the ticket and the record again. False when the note does not say enough to start it
// (an old note names no step, a note at apply no change or build pipeline).
export async function startStopped(ctx: StepContext, ref: TicketRef, note: Extract<Read<"stopped">, { kind: "stopped" }>): Promise<boolean> {
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
  // A run a switch stopped, or one that waited out the network before any agent ran, has no session: that step starts afresh.
  if (!p || !(p.sessionId || p.switchOff || p.network)) return { why: `the record of pipeline ${buildRun} has no saved session` };
  // The questions agent runs inside the triage job.
  return { at: p.step === "questions" ? "triage" : p.step, sessionId: p.sessionId };
}

// Continue the loaded run: the build jobs before resumeAt skip.
// `round`: a request round starts here; the dashboard hears which one.
export async function continueAt(ctx: StepContext, ref: TicketRef, resumeAt: string, d: { actor?: string; fromPipeline: string; sessionId?: string; round?: number }): Promise<StepOutcome> {
  save(ctx, "event", { start: true, resume: true, ticket: ref, resumeAt, ...d });
  startStep(ctx, d.round ? { round: d.round } : {});
  await ctx.tracker.setState(ref, "running");
  return NEXT;
}

// The event step of a pipeline a schedule or a resume started for a waiting or stopped run. The record is loaded
// already, through the provenance-checked loader. Never start over silently.
export async function resume(ctx: StepContext, ref: TicketRef, buildRun: string): Promise<StepOutcome> {
  const noStart = (reason: string) => (save(ctx, "event", { start: false, reason, ticket: ref }), ENDED);
  const state = (await ctx.tracker.ticket(ref)).state;
  if (state !== "waiting" && state !== "stopped") return noStart("not-waiting");
  const point = continuePoint(ctx, ref, buildRun, "paused");
  if ("why" in point) return block(`The factory could not resume this run: ${point.why}. Add factory_ready to start again.`);
  // This ticket is waiting, so it is one of the active runs already.
  if ((await activeRuns(ctx)) - 1 >= maxRuns(ctx)) return noStart("repo-full");
  await ctx.ci.restoreRun(buildRun);
  return continueAt(ctx, ref, point.at, { fromPipeline: buildRun, sessionId: point.sessionId });
}

// A trusted person's `@factory resume` on a stopped ticket (the caller checked both). It continues the run named in the
// factory's newest stop note, a finish run the apply switch stopped as a finish run.
export async function resumeOnCommand(ctx: StepContext, ref: TicketRef, actor: string, noStart: (reason: string) => StepOutcome): Promise<StepOutcome> {
  const note = await conversation(ctx).newest(ref, "stopped");
  // A cancelled pipeline saved nothing after the stop before it: only a restart helps.
  if (note?.kind === "cancelled") return noStart("cancelled");
  if (note?.kind === "stopped" && note.step === "apply") {
    if (!(await startStopped(ctx, ref, note))) return block("The factory could not resume this run: its stopped-run comment names no change or build pipeline. Add factory_ready to start again.");
    save(ctx, "event", { start: true, resume: true, ticket: ref, actor, change: note.change, fromPipeline: note.buildRun });
    return ENDED;
  }
  const buildRun = note?.run;
  if (!buildRun) {
    noStart("no-stopped-run");
    return block("The factory could not resume this run: it found no stopped-run comment from the factory. Add factory_ready to start again.");
  }
  try {
    ctx.record = await ctx.ci.buildRecord(buildRun);
  } catch (err) {
    noStart("record-unavailable");
    return block(`The factory could not resume this run: the record of pipeline ${buildRun} could not be loaded (${errText(err)}). Add factory_ready to start again.`);
  }
  return resume(ctx, ref, buildRun);
}

// A person set a blocked ticket ready again: continue the run at the job that blocked. Undefined: start a new run.
export async function continueBlocked(ctx: StepContext, e: Extract<FactoryEvent, { kind: "ready" }>): Promise<StepOutcome | undefined> {
  const buildRun = (await conversation(ctx).newest(e.ticket, "blocked"))?.run;
  if (!buildRun) return undefined;
  const fresh = ctx.record;
  let point: ReturnType<typeof continuePoint>;
  try {
    ctx.record = await ctx.ci.buildRecord(buildRun);
    point = continuePoint(ctx, e.ticket, buildRun, "blocked");
  } catch (err) {
    point = { why: `the record of pipeline ${buildRun} could not be loaded (${errText(err)})` };
  }
  if ("why" in point) {
    ctx.record = fresh;
    await ctx.tracker.comment(e.ticket, md("🔄", "New run", `The factory starts a new run, because it cannot continue the blocked run.`, `**Why:** ${point.why}.`));
    return undefined;
  }
  // The blocked job starts its rounds again. The gate job runs code review too.
  if (point.at === "code-review" || point.at === "precommit-gate") ctx.record = { ...ctx.record, rounds: { review: 0, gate: 0 } };
  // prepare-patch starts on a fresh clone, so a half-done edit never picks the .factory.yml commands.
  if (point.at !== "prepare-patch") await ctx.ci.restoreRun(buildRun);
  return continueAt(ctx, e.ticket, point.at, { actor: e.actor, fromPipeline: buildRun });
}
