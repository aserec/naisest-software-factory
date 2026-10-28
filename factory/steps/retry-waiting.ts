// Every hour: resume runs that stopped at Claude's usage limit (factory_waiting). It starts a build pipeline
// with the pipeline that hit the limit. That build's event step loads the record, checks it and resumes.
import { MAX_RUNS_PER_REPO } from "../event";
import { block, isMain, makeContext, WAITING_RUN, type StepContext } from "./context";
import { activeRuns } from "./event";

export async function retryWaiting(ctx: StepContext): Promise<number[]> {
  const { id } = await ctx.gitlab.getProject(ctx.target.projectPath);
  // A waiting run already holds its slot, so resuming it adds no run. Only more than 2 other runs stop it.
  if ((await activeRuns(ctx, id)) - 1 >= MAX_RUNS_PER_REPO) return [];
  const bot = await ctx.gitlab.botUserId();
  const started: number[] = [];
  for (const { iid } of await ctx.gitlab.listLabeled(id, "factory_waiting")) {
    // Only the bot's own note counts: anyone who can comment could write the same line.
    const pipelineId = (await ctx.gitlab.notes(id, iid)).filter((n) => n.authorId === bot).map((n) => WAITING_RUN.exec(n.body)?.[1]).find(Boolean);
    if (!pipelineId) {
      await block({ ...ctx, env: { ...ctx.env, workItemIid: iid } }, "The factory could not resume this run: it found no waiting-run comment from the factory. Add factory_ready to start again.");
      continue;
    }
    await ctx.startPipeline({ FACTORY_PIPELINE: "build", FACTORY_TARGET: ctx.target.name, FACTORY_WORK_ITEM_IID: String(iid), FACTORY_BUILD_PIPELINE_ID: pipelineId });
    started.push(iid);
  }
  return started;
}

export async function main() {
  if (process.env.FACTORY_SCHEDULE !== "retry") throw new Error("FACTORY_SCHEDULE must be retry");
  console.log(`Resumed work items: ${(await retryWaiting(makeContext(process.env))).join(", ") || "none"}`);
}
if (isMain(import.meta.url)) await main();
