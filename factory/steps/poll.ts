// Fallback for a webhook that did not fire: a schedule every 5 minutes starts build runs for
// tickets in the ready state. It sets no state. The build's event step re-checks the live state and
// claims the run, as it does for a webhook.
import { makeContext } from "../compose";
import { ACTIVE_STATES, MAX_RUNS_PER_REPO } from "../event";
import type { TicketRef } from "../seams";
import { isMain, type StepContext } from "./context";
import { activeRuns, mayStart } from "./event";

export async function pollReady(ctx: StepContext): Promise<TicketRef[]> {
  const free = MAX_RUNS_PER_REPO - (await activeRuns(ctx));
  if (free <= 0) return [];
  const start: TicketRef[] = [];
  for (const t of await ctx.tracker.list("ready")) {
    if (start.length >= free) break;
    if (t.state && ACTIVE_STATES.includes(t.state)) continue;
    // The event step would refuse an untrusted person's start. Skip it here, or it takes a free slot every 5 minutes.
    const actor = await ctx.tracker.startedBy(t.ref);
    if (!actor || !(await mayStart(ctx, actor, t))) continue;
    await ctx.ci.start({ kind: "build", ticket: t.ref });
    start.push(t.ref);
  }
  return start;
}

export async function main() {
  if (process.env.FACTORY_SCHEDULE !== "poll") throw new Error("FACTORY_SCHEDULE must be poll");
  const ctx = makeContext(process.env);
  // local-factory.sh: print the tickets to start, start no pipeline. The script runs them on this machine.
  if (process.argv.includes("--list")) {
    console.log((await pollReady({ ...ctx, ci: { ...ctx.ci, start: async () => {} } })).join(" "));
    return;
  }
  console.log(`Started build runs for tickets: ${(await pollReady(ctx)).join(", ") || "none"}`);
}
if (isMain(import.meta.url)) await main();
