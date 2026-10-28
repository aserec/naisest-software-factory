import { ACTIVE_LABELS, decideStart, parseLabelEvent } from "../event";
import type { StateLabel } from "../gitlab";
import { isMain, runStep, save, type StepContext, type StepResult } from "./context";

// Caller side of decideStart's contract: CI runs this job in a resource_group, labels are read live,
// and factory_running is set before the job ends.
export async function run(ctx: StepContext): Promise<StepResult> {
  const e = parseLabelEvent(ctx.env.payload);
  if (!e || e.projectPath !== ctx.target.projectPath) {
    save(ctx, "event", { start: false, reason: e ? "other-project" : "not-added" });
    return "stop";
  }
  const { id } = await ctx.gitlab.getProject(ctx.target.projectPath);
  const item = await ctx.gitlab.getWorkItem(id, e.workItemIid);
  const counts = await Promise.all(ACTIVE_LABELS.map((l) => ctx.gitlab.countLabeled(id, l as StateLabel)));
  const decision = decideStart(e, {
    actorAccessLevel: await ctx.gitlab.memberAccessLevel(id, e.actorId),
    workItemLabels: item.labels,
    runningInRepo: counts.reduce((a, b) => a + b, 0),
  });
  ctx.record = { ...ctx.record, workItem: `${e.projectPath}#${e.workItemIid}` };
  save(ctx, "event", { workItemIid: e.workItemIid, actorId: e.actorId, ...decision });
  if (!decision.start) return "stop";
  await ctx.gitlab.setState(id, e.workItemIid, "factory_running");
  return "next";
}

export const main = () => runStep("event", run);
if (isMain(import.meta.url)) await main();
