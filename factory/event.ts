export interface LabelEvent { projectPath: string; workItemIid: number; actorId: number; labelsBefore: string[]; labelsAfter: string[] }

const LABEL = "factory_ready";
const DEVELOPER = 30;
const MAX_RUNS_PER_REPO = 2;

const titles = (v: unknown): string[] =>
  Array.isArray(v) ? v.flatMap((l) => (typeof l?.title === "string" ? [l.title] : [])) : [];

// Returns an event only when factory_ready was just added. Anything else gives null.
export function parseLabelEvent(payload: unknown): LabelEvent | null {
  const p = payload as any;
  if (p?.object_kind !== "issue" && p?.object_kind !== "work_item") return null;
  const change = p.changes?.labels;
  if (!change) return null;
  const labelsBefore = titles(change.previous);
  const labelsAfter = titles(change.current);
  if (!labelsAfter.includes(LABEL) || labelsBefore.includes(LABEL)) return null;
  const projectPath = p.project?.path_with_namespace;
  const workItemIid = p.object_attributes?.iid;
  const actorId = p.user?.id;
  if (typeof projectPath !== "string" || typeof workItemIid !== "number" || typeof actorId !== "number") return null;
  return { projectPath, workItemIid, actorId, labelsBefore, labelsAfter };
}

export type StartDecision = { start: true } | { start: false; reason: "not-added" | "not-member" | "active-run" | "repo-full" };

export function decideStart(
  e: LabelEvent,
  ctx: { actorAccessLevel: number; workItemLabels: string[]; runningInRepo: number },
): StartDecision {
  if (!e.labelsAfter.includes(LABEL)) return { start: false, reason: "not-added" };
  if (ctx.actorAccessLevel < DEVELOPER) return { start: false, reason: "not-member" };
  if (ctx.workItemLabels.includes("factory_running")) return { start: false, reason: "active-run" };
  if (ctx.runningInRepo >= MAX_RUNS_PER_REPO) return { start: false, reason: "repo-full" };
  return { start: true };
}
