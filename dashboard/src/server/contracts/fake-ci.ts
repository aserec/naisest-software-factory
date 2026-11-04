import type { CiWorld, CiSeed } from "./ci.contract";

// A CI in memory: it records what it is asked to stop or start, and lists what it was seeded with.
export function fakeCi(seed: CiSeed): CiWorld {
  const cancelled: string[] = [];
  const dispatched: string[] = [];
  const imported = new Set<string>();
  let refusing = false;
  const write = async (list: string[], v: string) => {
    if (refusing) throw new Error("the fake CI refuses");
    list.push(v);
  };
  return {
    cancelled: () => cancelled,
    dispatched: () => dispatched,
    refuse: () => void (refusing = true),
    ci: {
      runningJobs: async () => seed.jobs.map(({ log, ...j }) => j),
      jobLog: async (job) => seed.jobs.find((j) => j.job === job)!.log,
      cancel: (run) => write(cancelled, run),
      startDispatch: (target) => write(dispatched, target),
      async importEvents(db) {
        const fresh = seed.events.filter((e) => !imported.has(e.id));
        fresh.forEach((e) => imported.add(e.id));
        return db.addEvents(fresh);
      },
    },
  };
}
