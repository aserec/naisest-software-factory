import { block, data, isMain, runStep, save, waitFor, workItem, type StepContext, type StepResult } from "./context";

const DEVELOPER = 30;

// A person approved: someone other than the bot, with the Developer role or higher.
async function approvedByPerson(ctx: StepContext, projectId: number, mrIid: number): Promise<boolean> {
  const bot = await ctx.gitlab.botUserId();
  for (const id of await ctx.gitlab.approvedBy(projectId, mrIid)) {
    if (id !== bot && (await ctx.gitlab.memberAccessLevel(projectId, id)) >= DEVELOPER) return true;
  }
  return false;
}

export async function run(ctx: StepContext): Promise<StepResult> {
  const { projectId, iid } = await workItem(ctx);
  const mrIid = ctx.env.mrIid;
  if (!mrIid) throw new Error("FACTORY_MR_IID is not set");
  // The record must belong to this work item and this MR, not to some other run.
  if (ctx.record.workItem !== `${ctx.target.projectPath}#${iid}` || data(ctx, "precommit-gate")?.mrIid !== mrIid) {
    return block(ctx, `The run record is for another work item or merge request (${ctx.record.workItem || "none"}), so the factory did not merge !${mrIid}.`);
  }
  if (ctx.env.skipApply) {
    // A person merged by hand. Nothing to merge; verify checks the merge commit.
    const mr = await ctx.gitlab.getMergeRequest(projectId, mrIid);
    if (mr.state !== "merged") return block(ctx, `The finish pipeline expected merge request !${mrIid} to be merged, but it is ${mr.state}.`);
    save(ctx, "apply", { mrIid, sha: mr.mergeSha, skipped: true });
    return "next";
  }
  if (data(ctx, "decision")?.kind !== "auto" && !(await approvedByPerson(ctx, projectId, mrIid))) {
    return block(ctx, `Merge request !${mrIid} needs a person's approval, and it has none. The factory did not merge.`);
  }
  const headSha = data(ctx, "risk-check")?.headSha;
  if (!headSha) return block(ctx, "The run record has no reviewed commit, so the factory did not merge.");
  // Merge only after the merge request's own pipeline reports success.
  const status = await waitFor(ctx, () => ctx.gitlab.mergeRequestPipelineStatus(projectId, mrIid));
  if (status !== "success") return block(ctx, `The merge request pipeline is ${status}, so the factory did not merge.`);
  save(ctx, "apply", { mrIid, sha: await ctx.gitlab.merge(projectId, mrIid, headSha) });
  return "next";
}

export const main = () => runStep("apply", run);
if (isMain(import.meta.url)) await main();
