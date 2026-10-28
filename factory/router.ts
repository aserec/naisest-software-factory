import type { Risk, Router, RouterRow } from "./types";

// Trivial and low risk use the low row. An effort score at or above effortBump moves up to the high row.
export function pickModels(risk: Risk, effort: number, router: Router): RouterRow {
  const low = (risk === "trivial" || risk === "low") && effort < router.effortBump;
  return low ? router.low : router.high;
}
