// Fallback for a webhook that did not fire: a schedule every 5 minutes starts build runs for
// tickets in the ready state. It sets no state. The build's event step re-checks the live state and
// claims the run, as it does for a webhook.
import { makeContext } from "../compose";
import { ACTIVE_STATES, MAX_RUNS_PER_REPO } from "../event";
import type { ControlRequest } from "../run-events";
import type { SwitchName, TicketRef } from "../seams";
import { emit } from "../emit";
import { cancelNote, isCancelNote, isMain, lastStop, parseStoppedNote, startStopped, switchOn, type StepContext } from "./context";
import { activeRuns, mayStart, readyActor, RESTART_MS } from "./event";

// `skip`: tickets this poll started already (handleRequests).
export async function pollReady(ctx: StepContext, skip: TicketRef[] = []): Promise<TicketRef[]> {
  if (!(await switchOn(ctx, "new_runs"))) return [];
  const free = MAX_RUNS_PER_REPO - (await activeRuns(ctx));
  if (free <= 0) return [];
  // A pending restart owns its ticket: handleRequests starts it, also after a failed start.
  const control = await ctx.dashboard.control(ctx.target.name).catch(() => undefined);
  const restarting = control?.requests.filter((r) => r.kind === "restart" && !r.outcome).map((r) => r.ticket) ?? [];
  const start: TicketRef[] = [];
  for (const t of await ctx.tracker.list("ready")) {
    if (start.length >= free) break;
    if ((t.state && ACTIVE_STATES.includes(t.state)) || skip.includes(t.ref) || restarting.includes(t.ref)) continue;
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
export async function resumeSwitchedOff(ctx: StepContext, skip: TicketRef[] = []): Promise<TicketRef[]> {
  // Unlike a running step, a resume needs the dashboard: a switch someone turned off must not count as on.
  const control = await ctx.dashboard.control(ctx.target.name).catch(() => undefined);
  if (!control) return [];
  const started: TicketRef[] = [];
  for (const { ref } of await ctx.tracker.list("stopped")) {
    if (skip.includes(ref)) continue;
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
// Returns the tickets it started. A failed request stays pending for the next poll and does not stop the others.
export async function handleRequests(ctx: StepContext): Promise<TicketRef[]> {
  const control = await ctx.dashboard.control(ctx.target.name).catch(() => undefined);
  if (!control) return [];
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
      const ok = retry ? await retryRestart(ctx, r) : t?.state === "stopped" && (r.kind === "resume" ? await resume(ctx, r) : await restart(ctx, r));
      if (ok) started.push(r.ticket);
      await ctx.dashboard.requestDone(r.id, ok ? "done" : "refused");
    } catch (e) {
      console.log(`Request ${r.id} (${r.kind} of ticket ${r.ticket}) failed: ${String(e).slice(0, 300)}`);
    }
  }
  return started;
}

// A cancelled pipeline saved nothing after the stop before it, so only a restart helps.
// The dashboard checked the role on the factory project; the target project must trust the person too (Ruling R45).
async function resume(ctx: StepContext, r: ControlRequest): Promise<boolean> {
  if (!(await ctx.tracker.trusted(r.user))) return false;
  const body = await lastStop(ctx, r.ticket);
  const note = body && !isCancelNote(body) && parseStoppedNote(body);
  return !!note && startStopped(ctx, r.ticket, note);
}

// The old run ends as blocked and the ticket is ready again. The new build's event step takes the factory's ready
// as the request user's (readyActor), so it gets a new run ID.
async function restart(ctx: StepContext, r: ControlRequest): Promise<boolean> {
  await ctx.tracker.comment(r.ticket, `Restarted from the dashboard by @${r.user}. This run ends as blocked and a new run starts.`);
  await ctx.tracker.setState(r.ticket, "blocked");
  await ctx.tracker.setState(r.ticket, "ready");
  return startRestart(ctx, r);
}

// Past RESTART_MS the event step no longer takes the factory's ready as the person's, so the ticket goes back
// to stopped rather than wait as a ready nobody can start (Ruling R47). The same window as readyActor.
async function retryRestart(ctx: StepContext, r: ControlRequest): Promise<boolean> {
  const age = Date.now() - Date.parse(r.at);
  if (age >= 0 && age <= RESTART_MS) return startRestart(ctx, r);
  await ctx.tracker.comment(r.ticket, "The restart could not start a new run within 15 minutes. The ticket is stopped again. Press Restart on the dashboard to try again.");
  await ctx.tracker.setState(r.ticket, "stopped");
  return false;
}

async function startRestart(ctx: StepContext, r: ControlRequest): Promise<boolean> {
  const url = await ctx.ci.start({ kind: "build", ticket: r.ticket });
  // Only once the new run is on its way. The old run's event names its own ticket and no poller pipeline or job.
  const vars = { ...ctx.ci.vars, ticket: r.ticket, run: undefined, job: undefined };
  emit({ ...ctx, record: { ...ctx.record, runId: r.run }, ci: { ...ctx.ci, vars } }, "run_end", { outcome: "restarted" });
  // The new run is started: a failure here must not leave the request pending, or the next poll starts a second run.
  await closeStoppedChange(ctx, r, url).catch((e) => console.log(`Closing the change of ticket ${r.ticket} failed: ${String(e).slice(0, 300)}`));
  return true;
}

// A run stopped at apply left its change open. The new run opens its own, so the old one is closed.
async function closeStoppedChange(ctx: StepContext, r: ControlRequest, url: string): Promise<void> {
  const body = await lastStop(ctx, r.ticket);
  const change = body && parseStoppedNote(body)?.change;
  if (!change || !(await ctx.codeHost.change(change)).open) return;
  await ctx.codeHost.commentChange(change, `This change was closed because the run was restarted from the dashboard by @${r.user}. The new run: ${url}`);
  await ctx.codeHost.closeChange(change);
}

// Tests pass their own context.
export async function main(ctx?: StepContext) {
  if (process.env.FACTORY_SCHEDULE !== "poll") throw new Error("FACTORY_SCHEDULE must be poll");
  ctx ??= makeContext(process.env);
  try {
    // Cancelled stops first, so a restart never meets the running state of a cancelled run.
    console.log(`Stopped tickets whose pipeline the dashboard cancelled: ${(await finishCancelledStops(ctx)).join(", ") || "none"}`);
    const handled = await handleRequests(ctx);
    console.log(`Started runs the dashboard asked for: ${handled.join(", ") || "none"}`);
    console.log(`Started build runs for tickets: ${(await pollReady(ctx, handled)).join(", ") || "none"}`);
    console.log(`Resumed runs a switch stopped: ${(await resumeSwitchedOff(ctx, handled)).join(", ") || "none"}`);
  } finally {
    await ctx.dashboard.flush(); // send() only queues: the restart's run_end must go out before the process ends
  }
}
if (isMain(import.meta.url)) await main();
