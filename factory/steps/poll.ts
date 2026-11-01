// Fallback for a webhook that did not fire: a schedule every minute starts build runs for
// tickets in the ready state. It sets no state. The build's event step re-checks the live state and
// claims the run, as it does for a webhook.
import { makeContext } from "../compose";
import type { TicketRef } from "../seams";
import { isMain, takeSnapshot, controls, type StepContext } from "./context";
import { ACTIVE_STATES, activeRuns, finishCancelledStops, handleRequests, MAX_RUNS_PER_REPO, mayStart, readyActor, resumeSwitchedOff } from "./run";

export { finishCancelledStops, handleRequests, resumeSwitchedOff };

// `skip`: tickets this poll started already (handleRequests).
export async function pollReady(ctx: StepContext, skip: TicketRef[] = []): Promise<TicketRef[]> {
  if (!(await controls(ctx)).switchOn("new_runs")) return [];
  const free = MAX_RUNS_PER_REPO - (await activeRuns(ctx));
  if (free <= 0) return [];
  // A pending restart owns its ticket: handleRequests starts it, also after a failed start.
  const restarting = (await controls(ctx)).requests.filter((r) => r.kind === "restart" && !r.outcome).map((r) => r.ticket);
  const start: TicketRef[] = [];
  for (const t of await ctx.tracker.list("ready")) {
    if (start.length >= free) break;
    if ((t.state && ACTIVE_STATES.includes(t.state)) || skip.includes(t.ref) || restarting.includes(t.ref)) continue;
    // One failed ticket must not stop the poller: it is logged and tried again next minute.
    try {
      // The event step would refuse an untrusted person's start. Skip it here, or it takes a free slot every minute.
      const actor = await readyActor(ctx, t.ref, (await ctx.tracker.startedBy(t.ref)) ?? "");
      if (!(await mayStart(ctx, actor, t))) continue;
      await ctx.ci.start({ kind: "build", ticket: t.ref });
      start.push(t.ref);
    } catch (e) {
      console.log(`Start of ticket ${t.ref} failed: ${String(e).slice(0, 300)}`);
    }
  }
  return start;
}

// Tests pass their own context.
export async function main(ctx?: StepContext) {
  if (process.env.FACTORY_SCHEDULE !== "poll") throw new Error("FACTORY_SCHEDULE must be poll");
  ctx = { ...(ctx ?? makeContext(process.env)) };
  takeSnapshot(ctx); // one read of the dashboard for the whole tick
  // local-factory.sh: print the tickets to start, start no pipeline. The script runs them on this machine.
  if (process.argv.includes("--list")) {
    console.log((await pollReady({ ...ctx, ci: { ...ctx.ci, start: async () => "" } })).join(" "));
    return;
  }
  try {
    // Cancelled stops first, so a restart never meets the running state of a cancelled run.
    console.log(`Stopped tickets whose pipeline the dashboard cancelled: ${(await finishCancelledStops(ctx)).join(", ") || "none"}`);
    const handled = await handleRequests(ctx);
    takeSnapshot(ctx); // handleRequests answered requests: pollReady must see the new outcomes, as before
    console.log(`Started runs the dashboard asked for: ${handled.join(", ") || "none"}`);
    console.log(`Started build runs for tickets: ${(await pollReady(ctx, handled)).join(", ") || "none"}`);
    console.log(`Resumed runs a switch stopped: ${(await resumeSwitchedOff(ctx, handled)).join(", ") || "none"}`);
  } finally {
    await ctx.dashboard.flush(); // send() only queues: the restart's run_end must go out before the process ends
  }
}
if (isMain(import.meta.url)) await main();
