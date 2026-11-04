import type { HostMetricsSeed } from "./host-metrics.contract";
import type { HostMetrics } from "../seams";

// Host metrics in memory: it gives what it was seeded with.
export function fakeHostMetrics(seed: HostMetricsSeed): HostMetrics {
  const sources = ["syslog"];
  return {
    sources,
    hostStats: async () => seed.stats,
    async logs(q) {
      if (!sources.includes(q.source)) throw new Error("unknown log source");
      return [...seed.lines].reverse();
    },
  };
}
