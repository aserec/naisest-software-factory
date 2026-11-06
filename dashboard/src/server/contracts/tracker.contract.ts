import { describe, expect, test } from "vitest";
import { NotSetUp } from "../not-set-up";
import { STATES, type FactoryState, type Risk, type Tracker } from "../seams";
import type { TargetInfo } from "../targets";

// A work item the adapter's world holds before the test.
export type Seed = { ticket: string; title: string; state: FactoryState; risk?: Risk; closed?: boolean };

// Every board Tracker must pass this. `make` gives the tracker and one target whose tracker holds `seed`; with setUp false, its address or read token is missing.
export function trackerContract(name: string, make: (seed: Seed[], o: { setUp: boolean }) => { tracker: Tracker; target: TargetInfo }) {
  describe(`${name} tracker contract`, () => {
    test("rows give each work item of the target in its factory state", async () => {
      const seed = STATES.map((state, n) => ({ ticket: String(n + 1), title: `T${n + 1}`, state }));
      const { tracker, target } = make(seed, { setUp: true });
      const rows = await tracker.rows([target]);
      expect(rows.map((r) => [r.target, r.ticket, r.title, r.state]).sort()).toEqual(seed.map((s) => [target.name, s.ticket, s.title, s.state]).sort());
    });

    test("a row carries the triage risk, and none before triage", async () => {
      const { tracker, target } = make([{ ticket: "1", title: "A", state: "ready", risk: "high" }, { ticket: "2", title: "B", state: "ready" }], { setUp: true });
      const rows = await tracker.rows([target]);
      expect(rows.find((r) => r.ticket === "1")?.risk).toBe("high");
      expect(rows.find((r) => r.ticket === "2")?.risk).toBeUndefined();
    });

    test("a row says whether the tracker closed the work item", async () => {
      const { tracker, target } = make([{ ticket: "1", title: "A", state: "running", closed: true }, { ticket: "2", title: "B", state: "running" }], { setUp: true });
      const rows = await tracker.rows([target]);
      expect(rows.map((r) => [r.ticket, !!r.closed]).sort()).toEqual([["1", true], ["2", false]]);
    });

    test("a row's url is the work item link that ticketUrl gives", async () => {
      const { tracker, target } = make([{ ticket: "5", title: "A", state: "running" }], { setUp: true });
      const [row] = await tracker.rows([target]);
      expect(row.url).toBe(tracker.ticketUrl(target, "5"));
      expect(new URL(row.url).protocol).toMatch(/^https?:$/);
    });

    test("rows throw NotSetUp without an address or read token", async () => {
      const { tracker, target } = make([{ ticket: "1", title: "A", state: "ready" }], { setUp: false });
      await expect(tracker.rows([target])).rejects.toBeInstanceOf(NotSetUp);
    });

    test("it has a display name", () => {
      expect(make([], { setUp: true }).tracker.name).not.toBe("");
    });
  });
}
