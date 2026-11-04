// The factory's own worker (seams.yml ci: local, FACTORY_CI=local here) in place of GitLab CI. The worker listens on the
// compose network only, and takes the dashboard token as its bearer.
import { NotSetUp } from "../not-set-up";
import type { Ci } from "../seams";

const noJobs = () => Promise.reject(new NotSetUp("The worker shows no job list or job log here. Read the worker's own log."));

export function makeLocalCi(fetchFn: typeof fetch = fetch): Ci {
  const post = async (path: string) => {
    const r = await fetchFn(`${process.env.FACTORY_WORKER_URL ?? "http://worker:8080"}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.FACTORY_DASHBOARD_TOKEN ?? ""}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`Worker ${r.status} for ${path.split("/").slice(0, 2).join("/")}`);
  };
  return {
    runningJobs: noJobs,
    jobLog: noJobs,
    // `run` is the run id the steps send (ctx.ci.vars.run). The worker stops the run's container and starts no next step.
    cancel: (run) => post(`/runs/${encodeURIComponent(run)}/cancel`),
    startDispatch: (target) => post(`/dispatch/${encodeURIComponent(target)}`),
    // The steps send their events to the dashboard themselves; there are no CI job artifacts to import from.
    importEvents: async () => 0,
  };
}
