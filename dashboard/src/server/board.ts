import { workItemKey } from "@/lib/utils";
import type { Db } from "./db";
import type { BoardRow } from "./seams";
import type { TargetInfo } from "./targets";

// The board's work items, each with what its newest run shows: cost, step, whether it is stuck, the change to review.
export function boardWithRuns(items: BoardRow[], db: Db, targets: TargetInfo[], now: Date) {
  const limits = new Map(targets.map((t) => [t.name, t.stuckMinutes]));
  const latest = new Map(db.latestRuns(items).map((r) => [workItemKey(r), r]));
  return items.map((i) => {
    const r = latest.get(workItemKey(i));
    const open = !!r && !r.endedAt;
    // The run's own events say whether it is stuck; the work item's state fills in for a run that sent no label_change.
    const view = r && db.view(r.run, { limits: limits.get(i.target) ?? {}, now, fallback: i.state });
    // The step the factory works on now: not between steps, not waiting for a person.
    const live = open && view && !view.paused && view.lastStep && !view.lastStep.ended ? view.lastStep : undefined;
    return {
      ...i, run: r?.run, costUsd: r?.costUsd, stuck: !!view?.stuck,
      step: open ? r.lastStep?.step : undefined, reached: r?.lastStep?.step, stepStartedAt: live?.startedAt, stepLimit: live && limits.get(i.target)?.[live.step],
      round: r?.round, mergeRisk: r?.mergeRisk, mergeRiskMax: r?.mergeRiskMax, changeUrl: r?.changeUrl, conflicts: r?.conflicts,
    };
  });
}
