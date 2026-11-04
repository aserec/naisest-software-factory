import { expect, it, vi } from "vitest";

vi.mock("@/server/auth", () => ({ auth: async () => ({ user: { name: "ann" } }) }));
vi.mock("@/server/gitlab-instance", () => ({ getGitLab: () => ({ runningJobs: async () => [{ job: "1", name: "build", pipeline: "7", startedAt: "2026-10-29T10:00:00Z" }] }) }));
const grafana = vi.hoisted(() => ({ hosts: undefined as unknown }));
vi.mock("@/server/grafana", () => ({
  runnerLogs: async () => {
    throw new Error("Grafana down");
  },
  hostStats: async () => {
    if (grafana.hosts instanceof Error) throw grafana.hosts;
    return [{ host: "vm1", diskUsedPct: 1, memUsedPct: 2 }];
  },
}));
const { NotSetUp } = await import("@/server/not-set-up");
const { GET } = await import("./route");

it("a failing Grafana call gives that part an error while jobs still load", async () => {
  const res = await GET(new Request("http://x/api/runner?source=docker"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    jobs: [{ job: "1", name: "build", pipeline: "7", startedAt: "2026-10-29T10:00:00Z" }],
    hosts: [{ host: "vm1", diskUsedPct: 1, memUsedPct: 2 }],
    logs: { error: "Grafana down" },
  });
});

it("a source with no settings is unset, not an error", async () => {
  grafana.hosts = new NotSetUp("Grafana is not set up.");
  const body = await (await GET(new Request("http://x/api/runner"))).json();
  expect(body.hosts).toEqual({ unset: "Grafana is not set up." });
  expect(body.logs).toEqual({ error: "Grafana down" });
  grafana.hosts = undefined;
});
