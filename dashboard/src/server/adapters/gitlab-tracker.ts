// The board of targets whose work items are GitLab issues, read with the server's GITLAB_READ_TOKEN.
import { NotSetUp } from "../not-set-up";
import { STATES, addBlockers, triageRisk, type BoardRow, type ChangeView, type Tracker } from "../seams";
import { gitlabUrl } from "./gitlab-url";
import { timeout } from "./timeout";

// GitLab's detailed_merge_status values that can merge, or are still being worked out; any other value stops the merge.
const NO_BLOCK = ["mergeable", "checking", "unchecked", "preparing", "approvals_syncing", "ci_still_running"];
const BLOCKS: Record<string, string> = {
  conflict: "it has conflicts with the base branch", need_rebase: "it needs a rebase", ci_must_pass: "the pipeline must pass", draft_status: "it is a draft",
  discussions_not_resolved: "open threads must be resolved", not_approved: "it needs an approval", requested_changes: "a reviewer asked for changes", blocked_status: "another merge request blocks it",
};
type Mr = { iid: number; web_url: string; source_branch: string; has_conflicts: boolean; detailed_merge_status: string };
export function changeOfMr(m: Mr | undefined): ChangeView {
  if (!m) return { conflicts: false };
  const s = m.detailed_merge_status;
  return { changeUrl: m.web_url, conflicts: s === "checking" || s === "unchecked" ? undefined : m.has_conflicts, mergeBlock: NO_BLOCK.includes(s) ? undefined : (BLOCKS[s] ?? s.replaceAll("_", " ")), checksFailed: s === "ci_must_pass" };
}

export function makeGitLabTracker(fetchFn: typeof fetch = fetch): Tracker {
  return {
    name: "GitLab",

    async rows(targets) {
      const token = process.env.GITLAB_READ_TOKEN;
      const base = gitlabUrl();
      if (!base || !token) throw new NotSetUp("Set GITLAB_URL and GITLAB_READ_TOKEN to see the GitLab targets.");
      type Issue = { iid: number; title: string; web_url: string; updated_at: string; labels: string[]; state: string };
      // Open and closed issues, newest update first, as the GitHub tracker reads them.
      // ponytail: one page of 100 per call, add paging if a state ever holds more than 100 issues.
      const get = async (path: string) => {
        const r = await fetchFn(`${base}/api/v4${path}`, { headers: { "PRIVATE-TOKEN": token }, signal: timeout() });
        if (!r.ok) throw new Error(`GitLab ${r.status} for ${path}`);
        return r.json();
      };
      // The open merge requests of each target, once, by the issue their factory/<iid>-<slug> branch names; the newest wins.
      // ponytail: one page of 100 open merge requests per target, add paging if a target ever has more.
      const changes = new Map(targets.map((t) => [t.name, get(`/projects/${encodeURIComponent(t.projectPath)}/merge_requests?state=opened&order_by=created_at&sort=asc&per_page=100`).then((mrs: Mr[]) =>
        new Map(mrs.flatMap((m) => { const iid = /^factory\/(\d+)-(?!-)/.exec(m.source_branch)?.[1]; return iid ? [[iid, m] as const] : []; })))]));
      const lists = targets.flatMap((t) =>
        STATES.map(async (state): Promise<BoardRow[]> => {
          const path = `/projects/${encodeURIComponent(t.projectPath)}/issues?labels=factory_${state}&order_by=updated_at&per_page=100`;
          const [issues, mrs] = await Promise.all([get(path) as Promise<Issue[]>, changes.get(t.name)!]);
          return issues.map((i) => ({ target: t.name, ticket: String(i.iid), title: i.title, state, url: i.web_url, updatedAt: i.updated_at, risk: triageRisk(i.labels), boardUrl: `${base}/${t.projectPath}/-/boards`, closed: i.state === "closed", ...changeOfMr(mrs.get(String(i.iid))) }));
        }),
      );
      const rows = (await Promise.all(lists)).flat();
      // GitLab's "is blocked by" links (factory/adapters/gitlab-tracker.ts).
      return addBlockers(rows, async (r) => {
        const t = targets.find((x) => x.name === r.target)!;
        const ls = (await get(`/projects/${encodeURIComponent(t.projectPath)}/issues/${r.ticket}/links`)) as { link_type: string; state: string; web_url: string }[];
        return ls.filter((l) => l.link_type === "is_blocked_by" && l.state === "opened").map((l) => l.web_url);
      });
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
