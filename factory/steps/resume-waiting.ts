// Every hour: resume runs that stopped at the agent's usage limit (state waiting). It starts a build run
// with the run that hit the limit. That build's event step loads the record, checks it and resumes.
import { makeContext } from "../compose";
import { conversation } from "../conversation";
import type { TicketRef } from "../seams";
import { isMain, switchOn, type StepContext } from "./context";
import { activeRuns, block, maxRuns } from "./run";

export async function resumeWaiting(ctx: StepContext): Promise<TicketRef[]> {
  if (!(await switchOn(ctx, "retry"))) return [];
  // A waiting run already holds its slot, so resuming it adds no run. Only more than 2 other runs stop it.
  if ((await activeRuns(ctx)) - 1 >= maxRuns(ctx)) return [];
  const started: TicketRef[] = [];
  for (const { ref } of await ctx.tracker.list("waiting")) {
    const run = (await conversation(ctx).newest(ref, "waiting"))?.run;
    if (!run) {
      await block({ ...ctx, ci: { ...ctx.ci, vars: { ...ctx.ci.vars, ticket: ref } } }, "The factory could not resume this run: it found no waiting-run comment from the factory. Add factory_ready to start again.");
      continue;
    }
    await ctx.ci.start({ kind: "build", ticket: ref, buildRun: run });
    started.push(ref);
  }
  return started;
}

export async function main() {
  if (process.env.FACTORY_SCHEDULE !== "retry") throw new Error("FACTORY_SCHEDULE must be retry");
  console.log(`Resumed tickets: ${(await resumeWaiting(makeContext(process.env))).join(", ") || "none"}`);
}
if (isMain(import.meta.url)) await main();
