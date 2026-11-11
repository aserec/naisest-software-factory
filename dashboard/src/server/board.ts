import { workItemKey } from "@/lib/utils";
import type { Db } from "./db";
import type { BoardRow } from "./seams";
import type { TargetInfo } from "./targets";
import { stepLimit } from "./run-view";

// The board's work items, each with what its newest run shows: cost, step, whether it is stuck, the change to review.
export function boardWithRuns(items: BoardRow[], db: Db, targets: TargetInfo[], now: Date) {
  const limits = new Map(targets.map((t) => [t.name, t.stuckMinutes]));
  const latest = new Map(db.latestRuns(items).map((r) => [workItemKey(r), r]));
  // Oldest first, so the map keeps each work item's newest change.
  const resolved = new Map(db.resolutions(items).map((r) => [workItemKey(r), r]));
  const lastChange = new Map(db.stateChanges(items).map((c) => [workItemKey(c), c]));
  return items.map((i) => {
    const r = latest.get(workItemKey(i));
    const change = lastChange.get(workItemKey(i));
    const open = !!r && !r.endedAt;
    // The run's own events say whether it is stuck; the work item's state fills in for a run that sent no label_change.
    const view = r && db.view(r.run, { limits: limits.get(i.target) ?? {}, now, fallback: i.state });
    // The step the factory works on now: not between steps, not waiting for a person.
    const live = open && view && !view.paused && view.lastStep && !view.lastStep.ended ? view.lastStep : undefined;
    return {
      ...i, run: r?.run, costUsd: r?.costUsd, stuck: !!view?.stuck,
      step: open ? r.lastStep?.step : undefined, reached: r?.lastStep?.step, stepStartedAt: live?.since, stepLimit: live && stepLimit(live, limits.get(i.target) ?? {}),
      // A person who moved the card by hand sent no label_change, so the factory's last change counts only when it matches the card's state.
      stateSince: change?.state === i.state ? change.at : undefined,
      round: r?.round, mergeRisk: r?.mergeRisk, mergeRiskMax: r?.mergeRiskMax, 
      // The tracker reads the open change now; the run's events fill in a merged change and what the tracker cannot tell yet.
      changeUrl: i.changeUrl ?? r?.changeUrl, conflicts: i.conflicts ?? r?.conflicts,
      resolvedCount: resolved.get(workItemKey(i))?.count, resolvedAt: resolved.get(workItemKey(i))?.last,
    };
  });
}
