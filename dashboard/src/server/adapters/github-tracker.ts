// The board of targets whose work items are GitHub issues (tracker github) or cards on a GitHub board (github-project), read with GITHUB_READ_TOKEN.
import { NotSetUp } from "../not-set-up";
import { STATES, triageRisk, type BoardRow, type ChangeView, type FactoryState, type Tracker } from "../seams";
import { githubApi } from "./github-url";
import { timeout } from "./timeout";

const web = () => (process.env.GITHUB_URL || "https://github.com").replace(/\/+$/, "");
// "Needs approval" -> needs_approval; undefined for a column that is no factory state.
const columnState = (name: string) => STATES.find((s) => s === name.trim().toLowerCase().replace(/\s+/g, "_"));

// GitHub's mergeStateStatus values that stop a merge. CLEAN, HAS_HOOKS and UNSTABLE (a check that is not required failed) can merge; UNKNOWN is still computing.
const BLOCKS: Record<string, string> = { DIRTY: "it has conflicts with the base branch", BEHIND: "it is behind the base branch", BLOCKED: "a required review or check is missing", DRAFT: "it is a draft" };
type Pr = { url: string; mergeable: string; mergeStateStatus: string; commits?: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] } };
// The newest open PR that closes the issue. UNKNOWN leaves conflicts and the block undefined, so the run's events decide.
export function changeOfPrs(prs: Pr[]): ChangeView {
  const p = prs.at(-1);
  if (!p) return { conflicts: false };
  return { changeUrl: p.url, conflicts: p.mergeable === "UNKNOWN" ? undefined : p.mergeable === "CONFLICTING", mergeBlock: BLOCKS[p.mergeStateStatus], checksFailed: ["FAILURE", "ERROR"].includes(p.commits?.nodes[0]?.commit.statusCheckRollup?.state ?? "") };
}

type Card = { state: FactoryState; repo: string; number: number; title: string; url: string; updatedAt: string; risk?: BoardRow["risk"]; boardUrl: string; closed: boolean } & ChangeView;

export function makeGitHubTracker(fetchFn: typeof fetch = fetch): Tracker {
  const headers = (token: string) => ({ Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" });
  const rest = async (token: string, path: string) => {
    const r = await fetchFn(`${githubApi()}${path}`, { headers: headers(token), signal: timeout() });
    if (!r.ok) throw new Error(`GitHub ${r.status} for ${path.split("?")[0]}`);
    return r.json();
  };
  const graphql = async (token: string, query: string, variables: object) => {
    const r = await fetchFn(`${githubApi()}/graphql`, { method: "POST", headers: headers(token), body: JSON.stringify({ query, variables }), signal: timeout() });
    const j = r.ok ? await r.json() : undefined;
    if (!j || j.errors?.length) throw new Error(`GitHub GraphQL failed with status ${r.status}`);
    return j.data;
  };

  // Every card of one board, read once for all targets that share it. ponytail: reads the whole board; filter with items(query:) if it grows past a few thousand cards.
  async function boardCards(token: string, owner: string, number: number) {
    const cards: Card[] = [];
    for (let after: string | null = null; ;) {
      const d = await graphql(
        token,
        `query($owner: String!, $n: Int!, $after: String) { repositoryOwner(login: $owner) { ... on ProjectV2Owner { projectV2(number: $n) { url items(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { updatedAt fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } } content { ... on Issue { number title url state repository { nameWithOwner } labels(first: 50) { nodes { name } } closedByPullRequestsReferences(first: 5, includeClosedPrs: false) { nodes { url mergeable mergeStateStatus commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } } } } } } } } }`,
        { owner, n: number, after },
      );
      const project = d.repositoryOwner?.projectV2;
      const items = project?.items;
      if (!items) throw new Error(`GitHub project ${owner}/${number} not found`);
      for (const n of items.nodes) {
        const c = n.content;
        const state = n.fieldValueByName && columnState(n.fieldValueByName.name);
        if (c?.number !== undefined && state) cards.push({ state, repo: c.repository.nameWithOwner, number: c.number, title: c.title, url: c.url, updatedAt: n.updatedAt, risk: triageRisk((c.labels?.nodes ?? []).map((l: { name: string }) => l.name)), boardUrl: project.url, closed: c.state === "CLOSED", ...changeOfPrs(c.closedByPullRequestsReferences?.nodes ?? []) });
      }
      if (!items.pageInfo.hasNextPage) return cards;
      after = items.pageInfo.endCursor;
    }
  }

  return {
    name: "GitHub",

    async rows(targets) {
      const token = process.env.GITHUB_READ_TOKEN;
      if (!token) throw new NotSetUp("Set GITHUB_READ_TOKEN to see the GitHub targets.");
      const boards = new Map<string, Promise<Card[]>>();
      const lists = targets.map(async (t): Promise<BoardRow[]> => {
        const repo = t.githubRepo!;
        if (t.githubProject === undefined) {
          const per = await Promise.all(STATES.map(async (state) => ((await rest(token, `/repos/${repo}/issues?labels=factory_${state}&state=all&sort=updated&per_page=100`)) as any[])
            .filter((i) => !i.pull_request)
            .map((i) => ({ target: t.name, ticket: String(i.number), title: i.title, state, url: i.html_url, updatedAt: i.updated_at, risk: triageRisk(i.labels.map((l: { name: string }) => l.name)), boardUrl: `${web()}/${repo}/issues`, closed: i.state === "closed" }))));
          return per.flat();
        }
        const owner = repo.split("/")[0];
        const key = `${owner}/${t.githubProject}`;
        if (!boards.has(key)) boards.set(key, boardCards(token, owner, t.githubProject));
        return (await boards.get(key)!)
          .filter((c) => c.repo === repo)
          .map((c) => ({ target: t.name, ticket: String(c.number), title: c.title, state: c.state, url: c.url, updatedAt: c.updatedAt, risk: c.risk, boardUrl: c.boardUrl, closed: c.closed, changeUrl: c.changeUrl, conflicts: c.conflicts, mergeBlock: c.mergeBlock, checksFailed: c.checksFailed }));
      });
      return (await Promise.all(lists)).flat();
    },

    ticketUrl: (t, ticket) => `${web()}/${t.githubRepo}/issues/${ticket}`,

    // The relay bot has read access only, so its comment never counts as a member's (factory/relay.ts).
    async postRelay(t, ticket, body) {
      const token = process.env.TEAMS_RELAY_GITHUB_TOKEN;
      if (!token) throw new NotSetUp("Set TEAMS_RELAY_GITHUB_TOKEN to relay to GitHub.");
      return fetchFn(`${githubApi()}/repos/${t.githubRepo}/issues/${ticket}/comments`, {
        method: "POST",
        headers: { ...headers(token), "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
        signal: timeout(4000), // Teams waits 5 s for the answer
      });
    },
  };
}
