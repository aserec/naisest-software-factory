// Fallback for a webhook that did not fire: a schedule every minute starts build runs for
// tickets in the ready state. It sets no state. The build's event step re-checks the live state and
// claims the run, as it does for a webhook.
import { errText } from "../errors";
import { makeContext } from "../compose";
import type { TicketRef } from "../seams";
import { isMain, takeSnapshot, controls, type StepContext } from "./context";
import { pollRequests, replyOnChanges } from "./requests";
import { ACTIVE_STATES, activeRuns, endClosedRuns, finishCancelledStops, handleReadyRequests, handleRequests, MAX_RUNS_PER_REPO, mayStart, readyActor, resumeSwitchedOff } from "./run";

// `skip`: tickets this poll started already (handleRequests).
export async function pollReady(ctx: StepContext, skip: TicketRef[] = []): Promise<TicketRef[]> {
  if (!(await controls(ctx)).switchOn("new_runs")) return [];
  const active = await activeRuns(ctx);
  const free = MAX_RUNS_PER_REPO - active;
  if (free <= 0) {
    // stderr, so local-factory.sh's list stays clean; a stall must not look like a hang in its log.
    const waiting = (await ctx.tracker.list("ready")).length;
    if (waiting) console.error(`${waiting} ready ticket(s) wait: ${active} runs are active (running, waiting, stopped or needs approval), the limit is ${MAX_RUNS_PER_REPO}`);
    return [];
  }
  // A pending restart owns its ticket: handleRequests starts it, also after a failed start.
  const restarting = (await controls(ctx)).requests.filter((r) => r.kind === "restart" && !r.outcome).map((r) => r.ticket);
  const start: TicketRef[] = [];
  for (const t of await ctx.tracker.list("ready")) {
    if (start.length >= free) break;
    if ((t.state && ACTIVE_STATES.includes(t.state)) || skip.includes(t.ref) || restarting.includes(t.ref)) continue;
    // One failed ticket must not stop the poller: it is logged and tried again next minute.
    try {
      // The event step would refuse an untrusted person's start. Skip it here, or it takes a free slot every minute.
      const { actor } = await readyActor(ctx, t.ref, (await ctx.tracker.startedBy(t.ref)) ?? "");
      if (!(await mayStart(ctx, actor, t))) continue;
      await ctx.ci.start({ kind: "build", ticket: t.ref });
      start.push(t.ref);
    } catch (e) {
      console.log(`Start of ticket ${t.ref} failed: ${errText(e)}`);
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
    // Set to Ready only changes a label, so it runs here too; takeSnapshot again so pollReady sees it as done.
    try {
      if ((await handleReadyRequests(ctx)).length) takeSnapshot(ctx);
    } finally {
      await ctx.dashboard.flush();
    }
    console.log((await pollReady({ ...ctx, ci: { ...ctx.ci, start: async () => "" } })).join(" "));
    return;
  }
  try {
    // Cancelled stops first, so a restart never meets the running state of a cancelled run.
    console.log(`Stopped tickets whose pipeline the dashboard cancelled: ${(await finishCancelledStops(ctx)).join(", ") || "none"}`);
    console.log(`Ended runs whose work item or change a person closed: ${(await endClosedRuns(ctx)).join(", ") || "none"}`);
    console.log(`Set ready the tickets the dashboard asked for: ${(await handleReadyRequests(ctx)).join(", ") || "none"}`);
    const handled = await handleRequests(ctx);
    takeSnapshot(ctx); // handleRequests answered requests: pollReady must see the new outcomes, as before
    console.log(`Started runs the dashboard asked for: ${handled.join(", ") || "none"}`);
    const answered = await pollRequests(ctx, handled);
    console.log(`Started request rounds or set ready for tickets: ${answered.join(", ") || "none"}`);
    try {
      console.log(`Replied to requests on changes of tickets: ${(await replyOnChanges(ctx, answered)).join(", ") || "none"}`);
    } catch (e) {
      console.log(`Replies on changes failed: ${errText(e)}`);
    }
    console.log(`Started build runs for tickets: ${(await pollReady(ctx, handled)).join(", ") || "none"}`);
    console.log(`Resumed runs a switch stopped: ${(await resumeSwitchedOff(ctx, handled)).join(", ") || "none"}`);
  } finally {
    await ctx.dashboard.flush(); // send() only queues: the restart's run_end must go out before the process ends
  }
}
if (isMain(import.meta.url)) await main();
