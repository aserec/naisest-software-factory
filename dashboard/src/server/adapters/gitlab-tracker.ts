// The board of targets whose work items are GitLab issues, read with the server's GITLAB_READ_TOKEN.
import { NotSetUp } from "../not-set-up";
import { STATES, triageRisk, type BoardRow, type Tracker } from "../seams";
import { gitlabUrl } from "./gitlab-url";
import { timeout } from "./timeout";

export function makeGitLabTracker(fetchFn: typeof fetch = fetch): Tracker {
  return {
    name: "GitLab",

    async rows(targets) {
      const token = process.env.GITLAB_READ_TOKEN;
      const base = gitlabUrl();
      if (!base || !token) throw new NotSetUp("Set GITLAB_URL and GITLAB_READ_TOKEN to see the GitLab targets.");
      type Issue = { iid: number; title: string; web_url: string; updated_at: string; labels: string[] };
      // Open and closed issues, newest update first, as the GitHub tracker reads them.
      // ponytail: one page of 100 per call, add paging if a state ever holds more than 100 issues.
      const lists = targets.flatMap((t) =>
        STATES.map(async (state): Promise<BoardRow[]> => {
          const path = `/projects/${encodeURIComponent(t.projectPath)}/issues?labels=factory_${state}&order_by=updated_at&per_page=100`;
          const r = await fetchFn(`${base}/api/v4${path}`, { headers: { "PRIVATE-TOKEN": token }, signal: timeout() });
          if (!r.ok) throw new Error(`GitLab ${r.status} for ${path}`);
          return ((await r.json()) as Issue[]).map((i) => ({ target: t.name, ticket: String(i.iid), title: i.title, state, url: i.web_url, updatedAt: i.updated_at, risk: triageRisk(i.labels), boardUrl: `${base}/${t.projectPath}/-/boards` }));
        }),
      );
      return (await Promise.all(lists)).flat();
    },

    ticketUrl: (t, ticket) => {
      const base = gitlabUrl();
      return base ? `${base}/${t.projectPath}/-/issues/${ticket}` : "";
    },

    // The relay bot is a project Reporter, so its comment never counts as a member's (factory/relay.ts).
    async postRelay(t, ticket, body) {
      const token = process.env.TEAMS_RELAY_GITLAB_TOKEN;
      const base = gitlabUrl();
      if (!token || !base) throw new NotSetUp("Set GITLAB_URL and TEAMS_RELAY_GITLAB_TOKEN to relay to GitLab.");
      return fetchFn(`${base}/api/v4/projects/${encodeURIComponent(t.projectPath)}/issues/${ticket}/notes`, {
        method: "POST",
        headers: { "PRIVATE-TOKEN": token, "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
        signal: timeout(4000), // Teams waits 5 s for the answer
      });
    },
  };
}
