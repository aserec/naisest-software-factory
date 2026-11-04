import { makeGrafana } from "../adapters/grafana";
import { makeNoHostMetrics } from "../compose";
import { fakeHostMetrics } from "./fake-host-metrics";
import { hostMetricsContract, type HostMetricsSeed } from "./host-metrics.contract";

// Grafana over a fetch that answers like its Loki and metrics proxies.
const grafanaOver = (seed: HostMetricsSeed) => {
  process.env.GRAFANA_URL = "https://ops.example";
  process.env.LOKI_UID = "loki1";
  process.env.METRICS_UID = "prom1";
  const f = async (url: string) => {
    const u = new URL(url);
    if (u.pathname.includes("/loki/"))
      return Response.json({ data: { result: [{ stream: { host: "vm1" }, values: seed.lines.map((l) => [`${BigInt(Date.parse(l.at)) * 1_000_000n}`, l.line]) }] } });
    const disk = u.searchParams.get("query")!.includes("node_filesystem");
    return Response.json({ data: { result: seed.stats.map((s) => ({ metric: { host: s.host }, value: [0, String(disk ? s.diskUsedPct : s.memUsedPct)] })) } });
  };
  return makeGrafana(f as unknown as typeof fetch);
};

hostMetricsContract("fake", fakeHostMetrics, { configured: true });
hostMetricsContract("grafana", grafanaOver, { configured: true });
hostMetricsContract("none", () => makeNoHostMetrics(), { configured: false });
