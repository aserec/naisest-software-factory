import { randomUUID } from "node:crypto";
import type { RunEvent } from "software-factory/run-events";
import { describe, expect, test } from "vitest";
import { openDb } from "../db";
import { NotSetUp } from "../not-set-up";
import type { Ci, Job } from "../seams";

// What the adapter's world holds before the test: running jobs (each with its log) and the events of finished jobs.
export type CiSeed = { jobs: (Job & { log: string })[]; events: RunEvent[] };
// A CI and a look into its world: the runs cancelled, the targets dispatched. `refuse` makes the CI answer every write with an error.
export type CiWorld = { ci: Ci; cancelled(): string[]; dispatched(): string[]; refuse(): void };

export const ciEvent = (): RunEvent => ({ id: randomUUID(), run: "r1", at: "2026-10-29T10:00:00.000Z", target: "t1", ticket: "5", type: "error", data: { message: "m" } });

// Every Ci must pass this. A CI with no job list or job log (`listsJobs` false) says NotSetUp for them.
export function ciContract(name: string, make: (seed: CiSeed) => CiWorld, { listsJobs }: { listsJobs: boolean }) {
  const job: CiSeed["jobs"][number] = { job: "3", name: "run", run: "8", startedAt: "2026-10-29T10:00:00Z", runner: "r1", log: "line one\nline two" };
  describe(`${name} CI contract`, () => {
    test("cancel stops the run it is given and no other", async () => {
      const w = make({ jobs: [], events: [] });
      await w.ci.cancel("7");
      expect(w.cancelled()).toEqual(["7"]);
    });

    test("startDispatch starts the dispatch run of the target", async () => {
      const w = make({ jobs: [], events: [] });
      await w.ci.startDispatch("react_frontend");
      expect(w.dispatched()).toEqual(["react_frontend"]);
    });

    test("cancel and startDispatch throw when the CI refuses", async () => {
      const w = make({ jobs: [], events: [] });
      w.refuse();
      await expect(w.ci.cancel("7")).rejects.toThrow();
      await expect(w.ci.startDispatch("react_frontend")).rejects.toThrow();
    });

    test(listsJobs ? "runningJobs and jobLog give the running jobs and their log" : "runningJobs and jobLog say not set up", async () => {
      const w = make({ jobs: [job], events: [] });
      if (!listsJobs) {
        await expect(w.ci.runningJobs()).rejects.toBeInstanceOf(NotSetUp);
        await expect(w.ci.jobLog("3")).rejects.toBeInstanceOf(NotSetUp);
        return;
      }
      const { log, ...row } = job;
      expect(await w.ci.runningJobs()).toEqual([row]);
      expect(await w.ci.jobLog("3")).toBe(log);
    });

    test("importEvents stores each event once, however often it runs", async () => {
      const db = openDb(":memory:");
      const w = make({ jobs: [], events: [ciEvent()] });
      const first = await w.ci.importEvents(db);
      expect(db.events({}).events).toHaveLength(first);
      expect(await w.ci.importEvents(db)).toBe(0);
      expect(db.events({}).events).toHaveLength(first);
    });
  });
}
