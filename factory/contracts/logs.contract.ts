import { describe, expect, test } from "vitest";
import type { LogSource } from "../seams";

// Every LogSource must pass this: the fake on every push, the real adapter in the manual job.
export function logsContract(make: () => LogSource) {
  describe("log source contract", () => {
    test("every group has 24 hourly counts", async () => {
      const groups = await make().errors(new Date(0));
      expect(groups.length).toBeGreaterThan(0);
      for (const g of groups) expect(g.hourly).toHaveLength(24);
    });

    test("firstSeen is not after lastSeen", async () => {
      for (const g of await make().errors(new Date(0))) expect(Date.parse(g.firstSeen)).toBeLessThanOrEqual(Date.parse(g.lastSeen));
    });

    test("fingerprints are unique", async () => {
      const prints = (await make().errors(new Date(0))).map((g) => g.fingerprint);
      expect(new Set(prints).size).toBe(prints.length);
    });

    test("a group last seen before `since` is left out", async () => {
      expect(await make().errors(new Date(Date.now() + 3_600_000 * 24 * 365))).toEqual([]);
    });
  });
}
