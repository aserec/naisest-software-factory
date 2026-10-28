import { ACTIVE_LABELS, decideStart, parseLabelEvent, parseMergeRequestEvent, type MergeRequestEvent } from "../event";
import type { StateLabel } from "../gitlab";
import { isMain, runStep, save, type StepContext, type StepResult } from "./context";

// Caller side of decideStart's contract: CI runs this job in a resource_group, labels are read live,
// and factory_running is set before the job ends.
const DEVELOPER = 30;

// Spec 6.7: a person approved a factory MR, or merged it by hand. Start the finish pipeline
// (with apply skipped after a manual merge). The build pipeline itself stops here.
async function mergeRequestEvent(ctx: StepContext, m: MergeRequestEvent): Promise<StepResult> {
  const quiet = (reason: string) => (save(ctx, "event", { start: false, reason, mrIid: m.mrIid }), "stop" as const);
  if (m.projectPath !== ctx.target.projectPath) return quiet("other-project");
  const { id } = await ctx.gitlab.getProject(ctx.target.projectPath);
  // The bot's own merge in apply sends a merge event too.
  if (m.actorId === (await ctx.gitlab.botUserId())) return quiet("bot");
  if ((await ctx.gitlab.memberAccessLevel(id, m.actorId)) < DEVELOPER) return quiet("not-member");
  // Only an MR that waits for a person. This also ignores approvals while the build is still running.
  if (!(await ctx.gitlab.getWorkItem(id, m.workItemIid)).labels.includes("factory_needs_approval")) return quiet("not-waiting");
  const mr = await ctx.gitlab.getMergeRequest(id, m.mrIid);
  const buildPipelineId = /\/pipelines\/(\d+)/.exec(mr.description)?.[1];
  ctx.record = { ...ctx.record, workItem: `${m.projectPath}#${m.workItemIid}` };
  save(ctx, "event", { start: true, workItemIid: m.workItemIid, actorId: m.actorId, action: m.action, mrIid: m.mrIid });
  await ctx.gitlab.setState(id, m.workItemIid, "factory_running");
  await ctx.startFinish({
    FACTORY_PIPELINE: "finish",
    FACTORY_TARGET: ctx.target.name,
    FACTORY_WORK_ITEM_IID: String(m.workItemIid),
    FACTORY_MR_IID: String(m.mrIid),
    ...(buildPipelineId ? { FACTORY_BUILD_PIPELINE_ID: buildPipelineId } : {}),
    ...(m.action === "merge" ? { FACTORY_SKIP_APPLY: "1" } : {}),
  });
  return "stop";
}

export async function run(ctx: StepContext): Promise<StepResult> {
  const m = parseMergeRequestEvent(ctx.env.payload);
  if (m) return mergeRequestEvent(ctx, m);
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
