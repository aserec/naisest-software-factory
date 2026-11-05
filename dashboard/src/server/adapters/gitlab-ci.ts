import { DASHBOARD_TYPES, dropUnknownKeys, runEvent, type RunEvent } from "software-factory/run-events";
import type { Db } from "../db";
import { NotSetUp } from "../not-set-up";
import type { Ci, Job } from "../seams";
import { gitlabUrl } from "./gitlab-url";

const base = () => {
  const url = gitlabUrl();
  if (!url) throw new NotSetUp("Set GITLAB_URL to use GitLab CI.");
  return url;
};

const LOG_BYTES = 200_000;

const id = (v: string) => {
  if (!/^\d+$/.test(v)) throw new Error(`not a numeric id: ${v}`);
  return v;
};

export function makeGitLabCi(fetchFn: typeof fetch = fetch, now: () => Date = () => new Date()): Ci {
  const factory = () => {
    if (!process.env.FACTORY_PROJECT_ID) throw new NotSetUp("FACTORY_PROJECT_ID is not set. Set it to the factory's GitLab project to see its running jobs.");
    return id(process.env.FACTORY_PROJECT_ID);
  };
  const get = (path: string) => fetchFn(`${base()}/api/v4${path}`, { headers: { "PRIVATE-TOKEN": process.env.GITLAB_READ_TOKEN ?? "" } });
  const getJson = async <T>(path: string) => {
    const r = await get(path);
    if (!r.ok) throw new Error(`GitLab ${r.status} for ${path}`);
    return (await r.json()) as T;
  };

  async function importJob(db: Db, job: string): Promise<number> {
    const r = await get(`/projects/${factory()}/jobs/${job}/artifacts/run/events.jsonl`);
    if (r.status !== 404 && !r.ok) return 0; // try again on the next import
    const events: RunEvent[] = [];
    if (r.ok) {
      for (const line of (await r.text()).split("\n")) {
        try {
          const p = runEvent.safeParse(JSON.parse(line));
          // Same as the collector route: skip the dashboard's own audit types and drop data keys the type does not know.
          if (p.success && !DASHBOARD_TYPES.has(p.data.type)) events.push(dropUnknownKeys(p.data));
        } catch {} // a bad line is skipped
      }
    }
    const added = events.length ? db.addEvents(events) : 0;
    db.markImported(job); // a 404 (no artifact) is recorded too, so it is not fetched again
    return added;
  }

  return {
    async jobLog(job) {
      const r = await get(`/projects/${factory()}/jobs/${id(job)}/trace`);
      if (!r.ok) throw new Error(`GitLab ${r.status} for the job log`);
      return (await r.text()).slice(-LOG_BYTES);
    },

    async runningJobs() {
      type GitLabJob = { id: number; name: string; pipeline: { id: number }; started_at: string; runner?: { description?: string } | null };
      const project = factory();
      const r = await get(`/projects/${project}/jobs?scope[]=running&per_page=100`);
      // GitLab answers 404 for a project the token cannot see, too.
      if (r.status === 404) throw new Error(`GitLab finds no project ${project} for the read token. Check FACTORY_PROJECT_ID and GITLAB_READ_TOKEN.`);
      if (r.status === 401 || r.status === 403) throw new Error(`GitLab refused the read token (${r.status}). Check GITLAB_READ_TOKEN.`);
      if (!r.ok) throw new Error(`GitLab answered ${r.status} for the running jobs.`);
      const jobs = (await r.json()) as GitLabJob[];
      return jobs.map((j): Job => ({ job: String(j.id), name: j.name, run: String(j.pipeline.id), startedAt: j.started_at, ...(j.runner?.description ? { runner: j.runner.description } : {}) }));
    },

    // Starts the factory's dispatch run for a target through the trigger API. The trigger token goes in the body, so errors never show it.
    async startDispatch(target) {
      const token = process.env.FACTORY_TRIGGER_TOKEN;
      if (!token) throw new Error("FACTORY_TRIGGER_TOKEN is not set");
      const body = new URLSearchParams({ token, ref: "main", "variables[FACTORY_PIPELINE]": "dispatch", "variables[FACTORY_TARGET]": target });
      const r = await fetchFn(`${base()}/api/v4/projects/${factory()}/trigger/pipeline`, { method: "POST", body });
      if (!r.ok) throw new Error(`GitLab ${r.status} for the dispatch run of ${target}`);
    },

    // Besides startDispatch, the only write the dashboard makes to GitLab.
    // `run` is a GitLab pipeline id.
    async cancel(run) {
      const r = await fetchFn(`${base()}/api/v4/projects/${factory()}/pipelines/${id(run)}/cancel`, { method: "POST", headers: { "PRIVATE-TOKEN": process.env.GITLAB_CANCEL_TOKEN ?? "" } });
      if (!r.ok) throw new Error(`GitLab ${r.status} for the pipeline cancel`);
    },

    async importEvents(db, sinceHours = 24) {
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
