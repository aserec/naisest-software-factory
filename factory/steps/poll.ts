// Fallback for a label webhook that did not fire: a schedule every 5 minutes starts build pipelines for
// work items labeled factory_ready. It sets no labels. The build's event step re-checks live labels and
// claims the run, as it does for a webhook.
import { ACTIVE_LABELS, DEVELOPER, MAX_RUNS_PER_REPO } from "../event";
import { isMain, makeContext, type StepContext } from "./context";
import { activeRuns } from "./event";

export async function pollReady(ctx: StepContext): Promise<number[]> {
  const { id } = await ctx.gitlab.getProject(ctx.target.projectPath);
  const free = MAX_RUNS_PER_REPO - (await activeRuns(ctx, id));
  if (free <= 0) return [];
  const start: number[] = [];
  for (const w of await ctx.gitlab.listLabeled(id, "factory_ready")) {
    if (start.length >= free) break;
    if (w.labels.some((l) => ACTIVE_LABELS.includes(l))) continue;
    // The event step would refuse a non-developer's label. Skip it here, or it takes a free slot every 5 minutes.
    const actorId = await ctx.gitlab.labelAddedBy(id, w.iid, "factory_ready");
    if (!actorId || (await ctx.gitlab.memberAccessLevel(id, actorId)) < DEVELOPER) continue;
    await ctx.startPipeline({ FACTORY_PIPELINE: "build", FACTORY_TARGET: ctx.target.name, FACTORY_WORK_ITEM_IID: String(w.iid) });
    start.push(w.iid);
  }
  return start;
}

export async function main() {
  if (process.env.FACTORY_SCHEDULE !== "poll") throw new Error("FACTORY_SCHEDULE must be poll");
  console.log(`Started build pipelines for work items: ${(await pollReady(makeContext(process.env))).join(", ") || "none"}`);
}
if (isMain(import.meta.url)) await main();
