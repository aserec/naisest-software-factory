export interface LabelEvent { projectPath: string; workItemIid: number; actorId: number; labelsBefore: string[]; labelsAfter: string[] }

const LABEL = "factory_ready";
const DEVELOPER = 30;
export const MAX_RUNS_PER_REPO = 2;
// A work item with one of these labels already has a run. needs_info, blocked and done do not.
export const ACTIVE_LABELS = ["factory_running", "factory_waiting", "factory_paused", "factory_needs_approval"];

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

// Caller contract:
// (a) handle one work item at a time (Task 12 uses a GitLab resource_group per work item);
// (b) pass workItemLabels read live from GitLab, not from the payload;
// (c) set factory_running before handling the next event;
// (d) runningInRepo is the number of OTHER active runs in the repo, not counting this item.
export function decideStart(
  e: LabelEvent,
  ctx: { actorAccessLevel: number; workItemLabels: string[]; runningInRepo: number },
): StartDecision {
  if (!e.labelsAfter.includes(LABEL)) return { start: false, reason: "not-added" };
  if (ctx.actorAccessLevel < DEVELOPER) return { start: false, reason: "not-member" };
  if (ctx.workItemLabels.some((l) => ACTIVE_LABELS.includes(l))) return { start: false, reason: "active-run" };
  if (ctx.runningInRepo >= MAX_RUNS_PER_REPO) return { start: false, reason: "repo-full" };
  return { start: true };
}

export interface MergeRequestEvent { projectPath: string; mrIid: number; workItemIid: number; action: "approved" | "merge"; actorId: number }

// An approval or a merge of a factory MR (branch factory/<work item iid>-<slug>). Anything else gives null.
export function parseMergeRequestEvent(payload: unknown): MergeRequestEvent | null {
  const p = payload as any;
  if (p?.object_kind !== "merge_request") return null;
  const a = p.object_attributes;
  if (a?.action !== "approved" && a?.action !== "merge") return null;
  const m = /^factory\/(\d+)-/.exec(String(a.source_branch ?? ""));
  const projectPath = p.project?.path_with_namespace;
  const actorId = p.user?.id;
  if (!m || typeof projectPath !== "string" || typeof a.iid !== "number" || typeof actorId !== "number") return null;
  return { projectPath, mrIid: a.iid, workItemIid: Number(m[1]), action: a.action, actorId };
}
