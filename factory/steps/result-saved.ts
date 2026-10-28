import { formatResult } from "../record";
import { card, data, isMain, runStep, save, workItem, type StepContext, type StepResult } from "./context";

export async function run(ctx: StepContext): Promise<StepResult> {
  const { projectId, iid } = await workItem(ctx);
  const mrUrl = data(ctx, "precommit-gate")?.mrUrl ?? `merge request !${ctx.env.mrIid}`;
  const text = formatResult(ctx.record, mrUrl, ctx.env.pipelineUrl, new Date());
  save(ctx, "result-saved", {});
  await ctx.gitlab.comment(projectId, iid, text);
  await ctx.gitlab.closeWorkItem(projectId, iid);
  await ctx.gitlab.setState(projectId, iid, "factory_done");
  await card(ctx, "done", text.split("\n"), mrUrl);
  return "next";
}

export const main = () => runStep("result-saved", run);
if (isMain(import.meta.url)) await main();
