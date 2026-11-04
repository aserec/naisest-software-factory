import { expect, test } from "vitest";
import type { RunEvent } from "../seams";
import { fakeDashboard } from "../fakes";
import { dashboardContract } from "./dashboard.contract";

dashboardContract(() => {
  const dashboard = fakeDashboard();
  return { dashboard, read: async (run) => dashboard.events.filter((e) => e.run === run) };
});

test("the fake's history keeps the target, the types and the times at or after since, compared as times", async () => {
  const dashboard = fakeDashboard();
  const ev = (id: string, at: string, type: RunEvent["type"] = "decision", target = "t"): RunEvent => ({ id, run: "r", at, target, ticket: "1", type, data: {} });
  for (const e of [ev("old", "2026-06-01T10:00:00Z"), ev("new", "2026-06-01T10:00:01Z"), ev("type", "2026-06-01T11:00:00Z", "usage"), ev("other", "2026-06-01T11:00:00Z", "decision", "u")]) dashboard.send(e);
  expect((await dashboard.history("t", "2026-06-01T10:00:00.500Z", ["decision"])).map((e) => e.id)).toEqual(["new"]);
  dashboard.down = true;
  await expect(dashboard.history("t", "2026-06-01T00:00:00Z", ["decision"])).rejects.toThrow("down");
});
