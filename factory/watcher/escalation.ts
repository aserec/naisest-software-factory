import type { ErrorGroup } from "../seams";

// Escalating = 3 or more in the last hour and at least 3 times the hourly average before it.
// A new error with 3 events counts (average 0); one event never does.
export function escalating(g: ErrorGroup): boolean {
  const [last, ...before] = g.hourly;
  const avg = before.reduce((a, b) => a + b, 0) / Math.max(before.length, 1);
  return last >= 3 && last >= 3 * avg;
}
