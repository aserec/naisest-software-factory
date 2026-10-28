import { block, isMain, runStep, save, waitFor, workItem, type StepContext, type StepResult } from "./context";

export async function run(ctx: StepContext): Promise<StepResult> {
  const { projectId } = await workItem(ctx);
  const mrIid = ctx.env.mrIid;
  if (!mrIid) throw new Error("FACTORY_MR_IID is not set");
  // Merge only after the merge request's own pipeline reports success.
  const status = await waitFor(ctx, () => ctx.gitlab.mergeRequestPipelineStatus(projectId, mrIid));
  if (status !== "success") return block(ctx, `The merge request pipeline is ${status}, so the factory did not merge.`);
  save(ctx, "apply", { mrIid, sha: await ctx.gitlab.merge(projectId, mrIid) });
  return "next";
}

export const main = () => runStep("apply", run);
if (isMain(import.meta.url)) await main();
