import { describe, expect, test } from "vitest";
import { NotSetUp } from "../not-set-up";
import type { HostMetrics, HostStat, LogLine } from "../seams";

// What the adapter's world holds: the host stats, and log lines oldest first.
export type HostMetricsSeed = { stats: HostStat[]; lines: LogLine[] };

// Every HostMetrics must pass this. One that is not set up (`configured` false) says NotSetUp and has no sources.
export function hostMetricsContract(name: string, make: (seed: HostMetricsSeed) => HostMetrics, { configured }: { configured: boolean }) {
  const seed: HostMetricsSeed = {
    stats: [{ host: "vm1", diskUsedPct: 41.5, memUsedPct: 72.25 }],
    lines: [
      { at: "2025-10-29T10:00:00.000Z", host: "vm1", line: "old" },
      { at: "2025-10-29T10:01:00.000Z", host: "vm1", line: "new" },
    ],
  };
  describe(`${name} host metrics contract`, () => {
    if (!configured) {
      test("it has no sources and says not set up", async () => {
        const m = make(seed);
        expect(m.sources).toEqual([]);
        await expect(m.hostStats()).rejects.toBeInstanceOf(NotSetUp);
        await expect(m.logs({ source: "docker", minutes: 5 })).rejects.toBeInstanceOf(NotSetUp);
      });
      return;
    }

    test("hostStats gives the disk and memory use of each host", async () => {
      expect(await make(seed).hostStats()).toEqual(seed.stats);
    });

    test("logs gives the lines of a source, newest first", async () => {
      const m = make(seed);
      expect(m.sources.length).toBeGreaterThan(0);
      expect((await m.logs({ source: m.sources[0], minutes: 5 })).map((l) => l.line)).toEqual(["new", "old"]);
    });

    test("logs refuses a source it does not list", async () => {
      await expect(make(seed).logs({ source: "no-such-source", minutes: 5 })).rejects.toThrow();
    });
  });
}
