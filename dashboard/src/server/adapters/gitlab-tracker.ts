// The board of targets whose work items are GitLab issues, read with the server's GITLAB_READ_TOKEN.
import { NotSetUp } from "../not-set-up";
import { STATES, type BoardRow, type Risk, type Tracker } from "../seams";

// The triage risk from the work item's factory_risk_* label, or undefined before triage.
export const triageRisk = (labels: string[]) => labels.map((l) => /^factory_risk_(trivial|low|medium|high)$/.exec(l)?.[1] as Risk | undefined).find(Boolean);

const base = () => (process.env.GITLAB_URL ?? "").replace(/\/+$/, "");

export function makeGitLabTracker(fetchFn: typeof fetch = fetch): Tracker {
  return {
    name: "GitLab",

    async rows(targets) {
      const token = process.env.GITLAB_READ_TOKEN;
      if (!base() || !token) throw new NotSetUp("Set GITLAB_URL and GITLAB_READ_TOKEN to see the GitLab targets.");
      type Issue = { iid: number; title: string; web_url: string; updated_at: string; labels: string[] };
      // ponytail: one page of 100 per call, add paging if a state ever holds more than 100 issues.
      const lists = targets.flatMap((t) =>
        STATES.map(async (state): Promise<BoardRow[]> => {
          const path = `/projects/${encodeURIComponent(t.projectPath)}/issues?labels=factory_${state}&per_page=100`;
          const r = await fetchFn(`${base()}/api/v4${path}`, { headers: { "PRIVATE-TOKEN": token } });
          if (!r.ok) throw new Error(`GitLab ${r.status} for ${path}`);
          return ((await r.json()) as Issue[]).map((i) => ({ target: t.name, ticket: String(i.iid), title: i.title, state, url: i.web_url, updatedAt: i.updated_at, risk: triageRisk(i.labels), boardUrl: `${base()}/${t.projectPath}/-/boards` }));
        }),
      );
      return (await Promise.all(lists)).flat();
    },

    ticketUrl: (t, ticket) => (base() ? `${base()}/${t.projectPath}/-/issues/${ticket}` : ""),
  };
}
