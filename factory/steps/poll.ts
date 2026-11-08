// Fallback for a webhook that did not fire: a schedule every minute starts build runs for
// tickets in the ready state. It sets no state. The build's event step re-checks the live state and
// claims the run, as it does for a webhook.
import { errText } from "../errors";
import { makeContext } from "../compose";
import type { TicketRef } from "../seams";
import { isMain, takeSnapshot, controls, type StepContext } from "./context";
import { pollRequests, replyOnChanges } from "./requests";
import { ACTIVE_STATES, activeRuns, MAX_RUNS_PER_REPO, mayStart, readyActor } from "./run";
import { endClosedRuns, finishCancelledStops, finishMerged, handleReadyRequests, handleRequests, restartDeadRuns, resumeRelayed, resumeSwitchedOff } from "./poller";
import type { CiRunner } from "../seams";

// Answered tickets first: they waited for a person already.
const startable = async (ctx: StepContext) => [...(await ctx.tracker.list("info_answered")), ...(await ctx.tracker.list("ready"))];

// `skip`: tickets this poll started already (handleRequests).
export async function pollReady(ctx: StepContext, skip: TicketRef[] = []): Promise<TicketRef[]> {
  if (!(await controls(ctx)).switchOn("new_runs")) return [];
  const active = await activeRuns(ctx);
  const free = MAX_RUNS_PER_REPO - active;
  if (free <= 0) {
    // stderr, so local-factory.sh's list stays clean; a stall must not look like a hang in its log.
    const waiting = (await startable(ctx)).length;
    if (waiting) console.error(`${waiting} ready ticket(s) wait: ${active} runs are active (running, waiting or stopped), the limit is ${MAX_RUNS_PER_REPO}`);
    return [];
  }
  // A pending restart owns its ticket: handleRequests starts it, also after a failed start.
  const restarting = (await controls(ctx)).requests.filter((r) => r.kind === "restart" && !r.outcome).map((r) => r.ticket);
  const start: TicketRef[] = [];
  for (const t of await startable(ctx)) {
    if (start.length >= free) break;
    if ((t.state && ACTIVE_STATES.includes(t.state)) || skip.includes(t.ref) || restarting.includes(t.ref)) continue;
    // One failed ticket must not stop the poller: it is logged and tried again next minute.
    try {
      // The event step would refuse an untrusted person's start. Skip it here, or it takes a free slot every minute.
      const { actor } = await readyActor(ctx, t.ref, (await ctx.tracker.startedBy(t.ref)) ?? "", t.state);
      if (!(await mayStart(ctx, actor, t))) continue;
      const blockers = await ctx.tracker.openBlockers(t.ref);
      if (blockers.length) { console.error(`Ticket ${t.ref} waits: blocked by ${blockers.join(", ")}, still open`); continue; }
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
  if (!process.argv.includes("--list")) return tick(ctx);
  // local-factory.sh: the same tick, but the runs it starts print as a list the script runs on this machine, and the log goes to stderr.
  // A build prints as ticket[:build run[:change]]: a round (requests or conflicts) or a resume restores that build run.
  const list: string[] = [];
  const start: CiRunner["start"] = async (r) => {
    if (r.kind !== "build") throw new Error("local-factory.sh runs build runs only, so it cannot start this finish run");
    list.push([r.ticket, r.buildRun, r.change].filter(Boolean).join(":"));
    return "";
  };
  const log = console.log;
  console.log = console.error;
  try {
    await tick({ ...ctx, ci: { ...ctx.ci, start } }, true);
  } finally {
    console.log = log;
  }
  console.log(list.join(" "));
}

// One poll: the work of the minute, in this order.
async function tick(ctx: StepContext, idle = false) {
  takeSnapshot(ctx); // one read of the dashboard for the whole tick
  try {
    // Cancelled stops first, so a restart never meets the running state of a cancelled run.
    console.log(`Stopped tickets whose pipeline the dashboard cancelled: ${(await finishCancelledStops(ctx, idle)).join(", ") || "none"}`);
    // After the stops: a dead run a person asked to stop stays stopped. Only local-factory.sh is idle between runs.
    const revived = idle ? await restartDeadRuns(ctx) : [];
    if (idle) console.log(`Started again the tickets whose local run died: ${revived.join(", ") || "none"}`);
    console.log(`Ended runs whose work item or change a person closed: ${(await endClosedRuns(ctx)).join(", ") || "none"}`);
    console.log(`Started finish runs for changes a person merged: ${(await finishMerged(ctx)).join(", ") || "none"}`);
    console.log(`Set ready the tickets the dashboard asked for: ${(await handleReadyRequests(ctx)).join(", ") || "none"}`);
    const asked = await handleRequests(ctx);
    const handled = [...revived, ...asked]; // started already: no later poller starts them again
    takeSnapshot(ctx); // handleRequests answered requests: pollReady must see the new outcomes, as before
    console.log(`Started runs the dashboard asked for: ${asked.join(", ") || "none"}`);
    const answered = await pollRequests(ctx, handled);
    console.log(`Started request rounds or set ready for tickets: ${answered.join(", ") || "none"}`);
    try {
      console.log(`Replied to requests on changes of tickets: ${(await replyOnChanges(ctx, answered)).join(", ") || "none"}`);
    } catch (e) {
      console.log(`Replies on changes failed: ${errText(e)}`);
    }
    console.log(`Started build runs for tickets: ${(await pollReady(ctx, handled)).join(", ") || "none"}`);
    const switched = await resumeSwitchedOff(ctx, handled);
    console.log(`Resumed runs a switch stopped: ${switched.join(", ") || "none"}`);
    console.log(`Resumed runs on a confirmed Teams resume: ${(await resumeRelayed(ctx, [...handled, ...switched])).join(", ") || "none"}`);
  } finally {
    await ctx.dashboard.flush(); // send() only queues: the restart's run_end must go out before the process ends
  }
}
if (isMain(import.meta.url)) await main();
