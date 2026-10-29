// Fallback for a webhook that did not fire: a schedule every 5 minutes starts build runs for
// tickets in the ready state. It sets no state. The build's event step re-checks the live state and
// claims the run, as it does for a webhook.
import { makeContext } from "../compose";
import { ACTIVE_STATES, MAX_RUNS_PER_REPO } from "../event";
import type { ControlRequest } from "../run-events";
import type { SwitchName, TicketRef } from "../seams";
import { emit } from "../emit";
import { cancelNote, isCancelNote, isMain, lastStop, parseStoppedNote, startStopped, switchOn, type StepContext } from "./context";
import { activeRuns, mayStart, readyActor } from "./event";

export async function pollReady(ctx: StepContext): Promise<TicketRef[]> {
  if (!(await switchOn(ctx, "new_runs"))) return [];
  const free = MAX_RUNS_PER_REPO - (await activeRuns(ctx));
  if (free <= 0) return [];
  const start: TicketRef[] = [];
  for (const t of await ctx.tracker.list("ready")) {
    if (start.length >= free) break;
    if (t.state && ACTIVE_STATES.includes(t.state)) continue;
    // The event step would refuse an untrusted person's start. Skip it here, or it takes a free slot every 5 minutes.
    const actor = await readyActor(ctx, t.ref, (await ctx.tracker.startedBy(t.ref)) ?? "");
    if (!(await mayStart(ctx, actor, t))) continue;
    await ctx.ci.start({ kind: "build", ticket: t.ref });
    start.push(t.ref);
  }
  return start;
}

// A run a dashboard switch stopped goes on once that switch is on again, in the same kind of pipeline it stopped in.
// A build run resumes through its event step, which checks the ticket and the record again.
export async function resumeSwitchedOff(ctx: StepContext): Promise<TicketRef[]> {
  // Unlike a running step, a resume needs the dashboard: a switch someone turned off must not count as on.
  const control = await ctx.dashboard.control(ctx.target.name).catch(() => undefined);
  if (!control) return [];
  const started: TicketRef[] = [];
  for (const { ref } of await ctx.tracker.list("stopped")) {
    const body = await lastStop(ctx, ref);
    const note = body && parseStoppedNote(body);
    const name = note && /^switch off (\w+)$/.exec(note.reason)?.[1];
    if (!note || !name || !control.switches[name as SwitchName]) continue;
    if (await startStopped(ctx, ref, note)) started.push(ref);
  }
  return started;
}

// The dashboard cancelled a pipeline that did not stop in time. That run saved nothing, so the poller marks the ticket stopped
// and says it can only be restarted. Then the dashboard hears the request is done.
export async function finishCancelledStops(ctx: StepContext): Promise<TicketRef[]> {
  const control = await ctx.dashboard.control(ctx.target.name).catch(() => undefined);
  if (!control) return [];
  const finished: TicketRef[] = [];
  for (const r of control.requests) {
    if (r.kind !== "stop" || r.outcome !== "cancelled") continue;
    if ((await ctx.tracker.ticket(r.ticket)).state === "running") {
      // The comment first: without it a resume would read an older stop note.
      await ctx.tracker.comment(r.ticket, cancelNote(r.user));
      await ctx.tracker.setState(r.ticket, "stopped");
      finished.push(r.ticket);
    }
    await ctx.dashboard.requestDone(r.id, "done");
  }
  return finished;
}

// Resume and restart requests from the dashboard. The dashboard checked the person's role; the poller checks the ticket.
export async function handleRequests(ctx: StepContext): Promise<void> {
  const control = await ctx.dashboard.control(ctx.target.name).catch(() => undefined);
  if (!control) return;
  for (const r of control.requests) {
    if (r.outcome || (r.kind !== "resume" && r.kind !== "restart")) continue;
    const ok = (await ctx.tracker.ticket(r.ticket)).state === "stopped" && (r.kind === "resume" ? await resume(ctx, r.ticket) : await restart(ctx, r));
    await ctx.dashboard.requestDone(r.id, ok ? "done" : "refused");
  }
}

// A cancelled pipeline saved nothing after the stop before it, so only a restart helps.
async function resume(ctx: StepContext, ticket: TicketRef): Promise<boolean> {
  const body = await lastStop(ctx, ticket);
  const note = body && !isCancelNote(body) && parseStoppedNote(body);
  return !!note && startStopped(ctx, ticket, note);
}

// The old run ends as blocked and the ticket is ready again. The new build's event step takes the factory's ready
// as the request user's (readyActor), so it gets a new run ID.
async function restart(ctx: StepContext, r: ControlRequest): Promise<boolean> {
  await ctx.tracker.comment(r.ticket, `Restarted from the dashboard by @${r.user}. This run ends as blocked and a new run starts.`);
  await ctx.tracker.setState(r.ticket, "blocked");
  emit({ ...ctx, record: { ...ctx.record, runId: r.run }, ci: { ...ctx.ci, vars: { ...ctx.ci.vars, ticket: r.ticket } } }, "run_end", { outcome: "restarted" });
  await ctx.tracker.setState(r.ticket, "ready");
  await ctx.ci.start({ kind: "build", ticket: r.ticket });
  return true;
}

export async function main() {
  if (process.env.FACTORY_SCHEDULE !== "poll") throw new Error("FACTORY_SCHEDULE must be poll");
  const ctx = makeContext(process.env);
  // Cancelled stops first, so a restart never meets the running state of a cancelled run.
  console.log(`Stopped tickets whose pipeline the dashboard cancelled: ${(await finishCancelledStops(ctx)).join(", ") || "none"}`);
  await handleRequests(ctx);
  console.log(`Started build runs for tickets: ${(await pollReady(ctx)).join(", ") || "none"}`);
  console.log(`Resumed runs a switch stopped: ${(await resumeSwitchedOff(ctx)).join(", ") || "none"}`);
}
if (isMain(import.meta.url)) await main();
