import { ACTIVE_LABELS, MAX_RUNS_PER_REPO, decideStart, parseLabelEvent, parseMergeRequestEvent, type LabelEvent, type MergeRequestEvent } from "../event";
import type { StateLabel } from "../gitlab";
import { block, isMain, runStep, save, type StepContext, type StepResult } from "./context";

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
  await ctx.startPipeline({
    FACTORY_PIPELINE: "finish",
    FACTORY_TARGET: ctx.target.name,
    FACTORY_WORK_ITEM_IID: String(m.workItemIid),
    FACTORY_MR_IID: String(m.mrIid),
    ...(buildPipelineId ? { FACTORY_BUILD_PIPELINE_ID: buildPipelineId } : {}),
    ...(m.action === "merge" ? { FACTORY_SKIP_APPLY: "1" } : {}),
  });
  return "stop";
}

// Work items in the repo that hold a run slot.
export async function activeRuns(ctx: StepContext, projectId: number): Promise<number> {
  const counts = await Promise.all(ACTIVE_LABELS.map((l) => ctx.gitlab.countLabeled(projectId, l as StateLabel)));
  return counts.reduce((a, b) => a + b, 0);
}

// The hourly retry asks to resume a run that stopped at Claude's usage limit. runStep has already loaded
// that pipeline's record through the provenance-checked loader. Never start over silently.
async function resume(ctx: StepContext, iid: number, pipelineId: number): Promise<StepResult> {
  const quiet = (reason: string) => (save(ctx, "event", { start: false, reason, workItemIid: iid }), "stop" as const);
  const { id } = await ctx.gitlab.getProject(ctx.target.projectPath);
  if (!(await ctx.gitlab.getWorkItem(id, iid)).labels.includes("factory_waiting")) return quiet("not-waiting");
  const last = ctx.record.steps.at(-1);
  const d = last?.data as { sessionId?: string; limit?: boolean } | undefined;
  if (ctx.record.workItem !== `${ctx.target.projectPath}#${iid}`) return block(ctx, `The factory could not resume this run: the record of pipeline ${pipelineId} is for another work item. Add factory_ready to start again.`);
  if (!d?.limit || !d.sessionId) return block(ctx, `The factory could not resume this run: the record of pipeline ${pipelineId} has no saved session. Add factory_ready to start again.`);
  // This work item is waiting, so it is one of the active runs already.
  if ((await activeRuns(ctx, id)) - 1 >= MAX_RUNS_PER_REPO) return quiet("repo-full");
  await ctx.restoreRun(pipelineId);
  // The questions agent runs inside the triage job.
  const resumeAt = last!.step === "questions" ? "triage" : last!.step;
  save(ctx, "event", { start: true, resume: true, workItemIid: iid, fromPipeline: pipelineId, resumeAt, sessionId: d.sessionId });
  await ctx.gitlab.setState(id, iid, "factory_running");
  return "next";
}

export async function run(ctx: StepContext): Promise<StepResult> {
  const m = parseMergeRequestEvent(ctx.env.payload);
  if (m) return mergeRequestEvent(ctx, m);
  const { workItemIid, buildPipelineId } = ctx.env;
  if (ctx.env.payload === undefined && workItemIid && buildPipelineId) return resume(ctx, workItemIid, buildPipelineId);
  let e = parseLabelEvent(ctx.env.payload);
  // The poller starts with no payload. Build the event from live labels and the label history,
  // so decideStart checks exactly what it checks for a webhook.
  if (ctx.env.payload === undefined && workItemIid) {
    const { id } = await ctx.gitlab.getProject(ctx.target.projectPath);
    const labels = (await ctx.gitlab.getWorkItem(id, workItemIid)).labels;
    const actorId = (await ctx.gitlab.labelAddedBy(id, workItemIid, "factory_ready")) ?? 0;
    e = { projectPath: ctx.target.projectPath, workItemIid, actorId, labelsBefore: [], labelsAfter: labels } satisfies LabelEvent;
  }
  if (!e || e.projectPath !== ctx.target.projectPath) {
    save(ctx, "event", { start: false, reason: e ? "other-project" : "not-added" });
    return "stop";
  }
  const { id } = await ctx.gitlab.getProject(ctx.target.projectPath);
  const item = await ctx.gitlab.getWorkItem(id, e.workItemIid);
  const decision = decideStart(e, {
    actorAccessLevel: await ctx.gitlab.memberAccessLevel(id, e.actorId),
    workItemLabels: item.labels,
    runningInRepo: await activeRuns(ctx, id),
  });
  ctx.record = { ...ctx.record, workItem: `${e.projectPath}#${e.workItemIid}` };
  save(ctx, "event", { workItemIid: e.workItemIid, actorId: e.actorId, ...decision });
  if (!decision.start) return "stop";
  await ctx.gitlab.setState(id, e.workItemIid, "factory_running");
  return "next";
}

export const main = () => runStep("event", run);
if (isMain(import.meta.url)) await main();
