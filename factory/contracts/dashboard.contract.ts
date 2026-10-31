import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { SWITCHES } from "../run-events";
import type { Dashboard, RunEvent } from "../seams";

// Every Dashboard must pass this: the fake on every push, the real adapter in the manual job.
// `read` gives back the events stored for a run, or undefined when the dashboard does not let the factory read them.
export function dashboardContract(make: () => { dashboard: Dashboard; read?(run: string): Promise<RunEvent[] | undefined> }) {
  describe("dashboard contract", () => {
    test("events sent and flushed can be read back", async () => {
      const { dashboard, read } = make();
      const run = `contract-${randomUUID()}`;
      const events: RunEvent[] = [1, 2, 3].map((n) => ({ id: randomUUID(), run, at: new Date().toISOString(), target: "react_frontend", ticket: "1", step: `step-${n}`, type: "step_start", data: {} }));
      for (const e of events) dashboard.send(e);
      await dashboard.flush();
      const stored = await read?.(run);
      if (stored) expect(stored.map((e) => e.id)).toEqual(events.map((e) => e.id));
    });

    test("control gives every switch", async () => {
      const state = await make().dashboard.control("react_frontend");
      expect(Object.keys(state.switches).sort()).toEqual([...SWITCHES].sort());
    });

    test("requestDone of an unknown id does not throw", async () => {
      await expect(make().dashboard.requestDone(randomUUID(), "done")).resolves.toBeUndefined();
    });
  });
}
