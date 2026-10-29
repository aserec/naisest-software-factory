import { EVENT_DATA, runEvent, type RunEvent } from "software-factory/run-events";
import { gitlab } from "./auth";
import type { Db } from "./db";
import { readTargets } from "./targets";

const STATES = ["ready", "running", "waiting", "needs_info", "needs_approval", "done", "stopped", "blocked"].map((s) => `factory_${s}`);
const CACHE_MS = 15_000;
const LOG_BYTES = 200_000;

const id = (v: string) => {
  if (!/^\d+$/.test(v)) throw new Error(`not a numeric id: ${v}`);
  return v;
};

export function makeGitLab(fetchFn: typeof fetch = fetch, now: () => Date = () => new Date()) {
  const factory = () => id(process.env.FACTORY_PROJECT_ID ?? "");
  // ponytail: one page of 100 per call, add paging if a state ever holds more than 100 issues.
  const get = (path: string) => fetchFn(`${gitlab()}/api/v4${path}`, { headers: { "PRIVATE-TOKEN": process.env.GITLAB_READ_TOKEN ?? "" } });
  const getJson = async <T>(path: string) => {
    const r = await get(path);
    if (!r.ok) throw new Error(`GitLab ${r.status} for ${path}`);
    return (await r.json()) as T;
  };

  let cached: { at: number; rows: ReturnType<typeof fetchBoard> } | undefined;
  async function fetchBoard() {
    type Issue = { iid: number; title: string; web_url: string; updated_at: string };
    const lists = readTargets().flatMap((t) =>
      STATES.map(async (state) => {
        const issues = await getJson<Issue[]>(`/projects/${encodeURIComponent(t.projectPath)}/issues?labels=${state}&per_page=100`);
        return issues.map((i) => ({ target: t.name, ticket: String(i.iid), title: i.title, state, url: i.web_url, updatedAt: i.updated_at }));
      }),
    );
    return (await Promise.all(lists)).flat();
  }

  async function importJob(db: Db, job: string): Promise<number> {
    const r = await get(`/projects/${factory()}/jobs/${job}/artifacts/run/events.jsonl`);
    if (r.status !== 404 && !r.ok) return 0; // try again on the next import
    const events: RunEvent[] = [];
    if (r.ok) {
      for (const line of (await r.text()).split("\n")) {
        try {
          const p = runEvent.safeParse(JSON.parse(line));
          // Same as the collector route: drop data keys the type does not know.
          if (p.success) events.push({ ...p.data, data: EVENT_DATA[p.data.type].parse(p.data.data) });
        } catch {} // a bad line is skipped
      }
    }
    const added = events.length ? db.addEvents(events) : 0;
    db.markImported(job); // a 404 (no artifact) is recorded too, so it is not fetched again
    return added;
  }

  return {
    board() {
      if (!cached || now().getTime() - cached.at >= CACHE_MS) {
        const entry = { at: now().getTime(), rows: fetchBoard() };
        cached = entry;
        entry.rows.catch(() => cached === entry && (cached = undefined)); // do not cache a failure
      }
      return cached.rows;
    },

    async jobLog(job: string) {
      const r = await get(`/projects/${factory()}/jobs/${id(job)}/trace`);
      if (!r.ok) throw new Error(`GitLab ${r.status} for the job log`);
      return (await r.text()).slice(-LOG_BYTES);
    },

    async runningJobs() {
      type Job = { id: number; name: string; pipeline: { id: number }; started_at: string; runner?: { description?: string } | null };
      const jobs = await getJson<Job[]>(`/projects/${factory()}/jobs?scope[]=running&per_page=100`);
      return jobs.map((j) => ({ job: String(j.id), name: j.name, pipeline: String(j.pipeline.id), startedAt: j.started_at, ...(j.runner?.description ? { runner: j.runner.description } : {}) }));
    },

    // The only write the dashboard makes to GitLab.
    async cancelPipeline(pipeline: string) {
      const r = await fetchFn(`${gitlab()}/api/v4/projects/${factory()}/pipelines/${id(pipeline)}/cancel`, { method: "POST", headers: { "PRIVATE-TOKEN": process.env.GITLAB_CANCEL_TOKEN ?? "" } });
      if (!r.ok) throw new Error(`GitLab ${r.status} for the pipeline cancel`);
    },

    async importEvents(db: Db, sinceHours = 24) {
      const since = new Date(now().getTime() - sinceHours * 3_600_000).toISOString();
      const pipelines = await getJson<{ id: number }[]>(`/projects/${factory()}/pipelines?updated_after=${encodeURIComponent(since)}&per_page=100`);
      let added = 0;
      for (const p of pipelines) {
        const jobs = await getJson<{ id: number }[]>(`/projects/${factory()}/pipelines/${id(String(p.id))}/jobs?scope[]=success&scope[]=failed&scope[]=canceled&per_page=100`);
        for (const j of jobs) {
          const job = id(String(j.id));
          if (!db.isImported(job)) added += await importJob(db, job);
        }
      }
      return added;
    },
  };
}
