import { beforeEach, expect, it, vi } from "vitest";
import { hostStats, runnerLogs } from "./grafana";

beforeEach(() => {
  process.env.GRAFANA_URL = "https://ops.example/";
  process.env.GRAFANA_TOKEN = "gt";
  process.env.LOKI_UID = "loki1";
  process.env.METRICS_UID = "prom1";
});

const json = (body: unknown) => new Response(JSON.stringify(body));

it("asks Loki through Grafana with the source label, the host and the Bearer token", async () => {
  const f = vi.fn(async (_url: string, _init?: RequestInit) =>
    json({ data: { result: [{ stream: { host: "vm1" }, values: [["1761732000000000000", "old"], ["1761732060000000000", "new"]] }] } }),
  );
  const logs = await runnerLogs({ host: "vm1", source: "gitlab-runner", minutes: 15 }, f as typeof fetch);
  const url = new URL(f.mock.calls[0][0]);
  expect(url.origin + url.pathname).toBe("https://ops.example/api/datasources/proxy/uid/loki1/loki/api/v1/query_range");
  expect(url.searchParams.get("query")).toBe('{job="factory-runner", source="gitlab-runner", host="vm1"}');
  expect(url.searchParams.get("limit")).toBe("500");
  expect(new Headers(f.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer gt");
  expect(logs).toEqual([
    { at: "2025-10-29T10:01:00.000Z", host: "vm1", line: "new" },
    { at: "2025-10-29T10:00:00.000Z", host: "vm1", line: "old" },
  ]);
});

it("quotes a host so it cannot change the query", async () => {
  const f = vi.fn(async (_url: string) => json({ data: { result: [] } }));
  await runnerLogs({ host: 'x"} or {a="b', source: "docker", minutes: 5 }, f as typeof fetch);
  expect(new URL(f.mock.calls[0][0]).searchParams.get("query")).toBe('{job="factory-runner", source="docker", host="x\\"} or {a=\\"b"}');
});

it("refuses a source outside the three before any fetch", async () => {
  const f = vi.fn();
  await expect(runnerLogs({ source: "kernel" as "docker", minutes: 5 }, f)).rejects.toThrow("unknown log source");
  expect(f).not.toHaveBeenCalled();
});

it("fails on a Grafana error answer", async () => {
  const f = vi.fn(async () => new Response("bad gateway", { status: 502 }));
  await expect(runnerLogs({ source: "system", minutes: 5 }, f)).rejects.toThrow("Grafana answered 502.");
});

it("reads disk and memory use per host from the metrics source", async () => {
  const f = vi.fn(async (url: string) => {
    const q = new URL(url).searchParams.get("query") ?? "";
    const value = q.includes("node_filesystem_avail_bytes") ? "41.5" : "72.25";
    return json({ data: { result: [{ metric: { host: "vm1" }, value: [1761732000, value] }] } });
  });
  expect(await hostStats(f as typeof fetch)).toEqual([{ host: "vm1", diskUsedPct: 41.5, memUsedPct: 72.25 }]);
  expect(String(f.mock.calls[0][0])).toContain("/api/datasources/proxy/uid/prom1/api/v1/query?");
});
