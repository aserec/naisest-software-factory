import type { RunSummary } from "@/server/db";

// A step that has not ended and runs longer than its limit (minutes) is stuck. A step without a limit never is.
export function isStuck(lastStep: RunSummary["lastStep"], limits: Record<string, number>, now: Date): boolean {
  const limit = lastStep && limits[lastStep.step];
  return !!lastStep && !lastStep.ended && limit !== undefined && now.getTime() - Date.parse(lastStep.startedAt) > limit * 60_000;
}
