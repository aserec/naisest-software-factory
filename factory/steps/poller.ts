// The poller's work on runs that no step runs (GLOSSARY.md: Paused run, Closed run, Resume, Restart): ending closed ones,
// starting the finish run of a change a person merged, and the dashboard's and Teams' requests. poll.ts runs these each tick.
import { runIds } from "../emit";
import { commandIn, conversation, md } from "../conversation";
import { errText, isNotFound } from "../errors";
import { SWITCHES, type ControlRequest } from "../run-events";
import type { FactoryState, SwitchName, Ticket, TicketRef } from "../seams";
import { controls, type StepContext } from "./context";
import { buildRunOf } from "./change-text";
import { ACTIVE_STATES, closedNow, endClosed, endRun, RESTART_MS, startStopped } from "./run";

// The runs with no step running. A running run's own steps check for itself.
const PAUSED: FactoryState[] = ACTIVE_STATES.filter((s) => s !== "running");
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
      const found = await closedNow(one, ref, PAUSED, (t) => pushed(ctx, t));
      if (!found) continue;
      await endClosed(one, ref, found);
      ended.push(ref);
    } catch (e) {
      console.log(`Ending closed ticket ${ref} failed: ${errText(e)}`);
    }
  }
  return ended;
}

// The poller: a person merged a waiting change by hand. The webhook (event.ts changeEvent) starts the finish run at once;
// without one (ci: local) this does, with apply skipped. Only a merge older than MERGE_GRACE_MS, so a webhook's event job goes first.
// ponytail: a webhook event job queued past the grace can still race this; both set running first, so it needs the same minute.
export const MERGE_GRACE_MS = 2 * 60_000;
export async function finishMerged(ctx: StepContext): Promise<TicketRef[]> {
  const started: TicketRef[] = [];
  for (const { ref } of await ctx.tracker.list("needs_approval")) {
    try {
      const found = await ctx.codeHost.changeOfTicket(ref);
      if (!found?.merged) continue;
      const change = await ctx.codeHost.change(found.ref);
      if (change.mergedAt && Date.now() - Date.parse(change.mergedAt) < MERGE_GRACE_MS) continue;
      const buildRun = buildRunOf(change.body);
      await ctx.tracker.setState(ref, "running"); // as the event step does: the next poll must not start it again
      try {
        await ctx.ci.start({ kind: "finish", ticket: ref, change: found.ref, ...(buildRun ? { buildRun } : {}), skipApply: true });
      } catch (e) {
        await ctx.tracker.setState(ref, "needs_approval"); // the next poll tries again
        throw e;
      }
      started.push(ref);
    } catch (e) {
      console.log(`Finish of merged ticket ${ref} failed: ${errText(e)}`);
    }
  }
  return started;
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

// The poller: a person's 👍 on a relayed `@factory resume` (relay.ts). A 👍 sends no comment webhook, so the event step never
// sees it; a person's own resume comment does send one and is left to the event step, so a run never starts twice.
export async function resumeRelayed(ctx: StepContext, skip: TicketRef[] = []): Promise<TicketRef[]> {
  const started: TicketRef[] = [];
  for (const { ref } of await ctx.tracker.list("stopped")) {
    if (skip.includes(ref)) continue;
    try {
      const note = await conversation(ctx).newest(ref, "stopped");
      if (note?.kind !== "stopped") continue; // a cancelled run can only be restarted
      let ok = false;
      for (const c of await ctx.tracker.comments(ref, note.at)) if (c.relayed && commandIn(c.body) === "resume" && (ok = await ctx.tracker.trusted(c.author))) break;
      if (ok && (await startStopped(ctx, ref, note))) started.push(ref);
    } catch (e) {
      console.log(`Relayed resume of ticket ${ref} failed: ${errText(e)}`);
    }
  }
  return started;
}

// The ticket, or undefined when it is gone (deleted, or a GitHub GraphQL NOT_FOUND).
const ticketOrGone = (ctx: StepContext, ref: TicketRef) => ctx.tracker.ticket(ref).catch((e): undefined => {
  if (isNotFound(e)) return undefined;
  throw e;
});

// The poller: the dashboard cancelled a pipeline that did not stop in time. That run saved nothing, so the ticket is
// marked stopped with a note that it can only be restarted. Then the dashboard hears the request is done.
// `idle`: local-factory.sh polls between its runs, so no run is alive and no pipeline exists to cancel. A stop that
// waits there belongs to a run that died (the loop was killed), and it counts as cancelled.
export async function finishCancelledStops(ctx: StepContext, idle = false): Promise<TicketRef[]> {
  const control = await controls(ctx);
  const finished: TicketRef[] = [];
  for (const r of control.requests) {
    if (r.kind !== "stop" || r.doneAt || (r.outcome !== "cancelled" && !idle)) continue;
    // One failed request must not stop the poller: it is logged and tried again next minute.
    try {
      // First, so the run page offers Restart, not Resume: this run saved nothing to resume from.
      if (r.outcome !== "cancelled") await ctx.dashboard.requestDone(r.id, "cancelled");
      const t = await ticketOrGone(ctx, r.ticket); // a gone ticket has nothing to stop
      if (t?.state === "running") {
        // The comment first: without it a resume would read an older stop note.
        await conversation(ctx).write(r.ticket, { kind: "cancelled", user: r.user });
        await ctx.tracker.setState(r.ticket, "stopped");
        finished.push(r.ticket);
      }
      await ctx.dashboard.requestDone(r.id, "done");
    } catch (e) {
      console.log(`Request ${r.id} (cancelled stop of ticket ${r.ticket}) failed: ${errText(e)}`);
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
      const t = await ticketOrGone(ctx, r.ticket);
      // A restart whose start failed set the ticket ready already: only the start is left.
      const retry = r.kind === "restart" && t?.state === "ready" && (await ctx.tracker.isFactory((await ctx.tracker.startedBy(r.ticket)) ?? ""));
      const ok = retry ? await restartAgain(ctx, r) : t?.state === "stopped" && (r.kind === "resume" ? await resumeRequest(ctx, r) : await restart(ctx, r));
      if (ok) started.push(r.ticket);
      await ctx.dashboard.requestDone(r.id, ok ? "done" : "refused");
    } catch (e) {
      console.log(`Request ${r.id} (${r.kind} of ticket ${r.ticket}) failed: ${errText(e)}`);
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
      const state = (await ticketOrGone(ctx, r.ticket))?.state;
      const ok = (state === "blocked" || state === "needs_info") && (await ctx.tracker.trusted(r.user));
      if (ok) {
        await ctx.tracker.comment(r.ticket, md("▶️", "Set to Ready", `@${r.user} set the work item to Ready from the dashboard.`));
        await ctx.tracker.setState(r.ticket, "ready");
        set.push(r.ticket);
      }
      await ctx.dashboard.requestDone(r.id, ok ? "done" : "refused");
    } catch (e) {
      console.error(`Request ${r.id} (ready of ticket ${r.ticket}) failed: ${errText(e)}`); // stderr: --list prints only ticket refs on stdout
    }
  }
  return set;
}

// The dashboard checked the role on the factory project; the target project must trust the person too.
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
// to stopped rather than wait as a ready nobody can start. The same window as readyActor.
async function restartAgain(ctx: StepContext, r: ControlRequest): Promise<boolean> {
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
  await closeStoppedChange(ctx, r, url).catch((e) => console.log(`Closing the change of ticket ${r.ticket} failed: ${errText(e)}`));
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
