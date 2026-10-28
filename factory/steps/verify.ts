import { block, data, isMain, runStep, save, waitFor, workItem, type StepContext, type StepResult } from "./context";

export async function run(ctx: StepContext): Promise<StepResult> {
  const { projectId, defaultBranch } = await workItem(ctx);
  const { sha } = data(ctx, "apply");
  const status = await waitFor(ctx, () => ctx.gitlab.pipelineStatus(projectId, defaultBranch, sha));
  save(ctx, "verify", { status });
  if (status === "success") {
    // ponytail: no smoke step yet; a target that names one goes to a person until it is built.
    if (data(ctx, "prepare-patch")?.commands?.smoke) return block(ctx, "The target's .factory.yml names a smoke test, but the factory cannot run smoke tests yet. A person must run it.");
    return "next";
  }
  const revert = await ctx.gitlab.revertMerge(projectId, sha, defaultBranch);
  return block(ctx, `The ${defaultBranch} pipeline is ${status} after the merge. A person must merge this revert: ${revert.webUrl}`);
}

export const main = () => runStep("verify", run);
if (isMain(import.meta.url)) await main();
