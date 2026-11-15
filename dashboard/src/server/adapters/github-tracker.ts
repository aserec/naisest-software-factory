// The board of targets whose work items are GitHub issues (tracker github) or cards on a GitHub board (github-project), read with GITHUB_READ_TOKEN.
import { NotSetUp } from "../not-set-up";
import { STATES, addBlockers, triageRisk, type BoardRow, type ChangeView, type FactoryState, type Tracker } from "../seams";
import { githubApi } from "./github-url";
import { timeout } from "./timeout";

const web = () => (process.env.GITHUB_URL || "https://github.com").replace(/\/+$/, "");
// "Factory: Needs approval" -> needs_approval; undefined for a column that is no factory state, such as the people's Backlog or Done.
const columnState = (name: string) => STATES.find((s) => s === /^factory:\s*(.+)$/i.exec(name.trim())?.[1].toLowerCase().replace(/\s+/g, "_"));

// GitHub's mergeStateStatus values that stop a merge. CLEAN, HAS_HOOKS and UNSTABLE (a check that is not required failed) can merge; UNKNOWN is still computing.
const BLOCKS: Record<string, string> = { DIRTY: "it has conflicts with the base branch", BEHIND: "it is behind the base branch", BLOCKED: "a required review or check is missing", DRAFT: "it is a draft" };
type Pr = { url: string; mergeable: string; mergeStateStatus: string; commits?: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] } };
// The newest open PR that closes the issue. UNKNOWN leaves conflicts and the block undefined, so the run's events decide.
export function changeOfPrs(prs: Pr[]): ChangeView {
  const p = prs.at(-1);
  if (!p) return { conflicts: false };
  return { changeUrl: p.url, conflicts: p.mergeable === "UNKNOWN" ? undefined : p.mergeable === "CONFLICTING", mergeBlock: BLOCKS[p.mergeStateStatus], checksFailed: ["FAILURE", "ERROR"].includes(p.commits?.nodes[0]?.commit.statusCheckRollup?.state ?? "") };
}

type Card = { state: FactoryState; repo: string; number: number; title: string; url: string; updatedAt: string; boardUrl: string; closed: boolean };
type Details = ChangeView & { risk?: BoardRow["risk"]; blockedBy?: string[] };

// A card's column, open or closed, and title: each board read asks only this, for 1 GraphQL point. Its details (risk,
// PR, blockers) cost more and change less, so they are read at most every DETAILS_MS, and never for a Done card.
export const DETAILS_MS = 30_000;
const col = (s: FactoryState) => `"factory: ${s.replace(/_/g, " ")}"`; // GitHub's filter ignores case
const ACTIVE = "status:" + STATES.filter((s) => s !== "done").map(col).join(",");
const DONE = `status:${col("done")} updated:>@today-7d`;
const CARD = "updatedAt fieldValueByName(name: \"Status\") { ... on ProjectV2ItemFieldSingleSelectValue { name } } content { ... on Issue { number title url state repository { nameWithOwner }";

export function makeGitHubTracker(fetchFn: typeof fetch = fetch, now: () => number = Date.now): Tracker {
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
  const projectOf = (d: any, owner: string, number: number) => {
    const p = d.repositoryOwner?.projectV2;
    if (!p) throw new Error(`GitHub project ${owner}/${number} not found`);
    return p;
  };
  // The newest answer of read(key) that is younger than DETAILS_MS. A failed read is not kept.
  const kept = new Map<string, { at: number; value: Promise<any> }>();
  function every<T>(key: string, read: () => Promise<T>): Promise<T> {
    const k = kept.get(key);
    if (k && now() - k.at < DETAILS_MS) return k.value;
    const value = read();
    kept.set(key, { at: now(), value });
    value.catch(() => kept.get(key)?.value === value && kept.delete(key));
    return value;
  }
  const blockers = async (token: string, url: string) => {
    const [, owner, name, , number] = new URL(url).pathname.split("/");
    const is = (await rest(token, `/repos/${owner}/${name}/issues/${number}/dependencies/blocked_by?per_page=100`)) as { state: string; html_url: string }[];
    return is.filter((i) => i.state === "open").map((i) => i.html_url);
  };

  // Every card in a factory column of one board, Done ones only when updated in the last 7 days. One request reads
  // both lists; @include skips a list once its pages are read.
  async function boardCards(token: string, owner: string, number: number) {
    const cards: Card[] = [];
    const page = `{ pageInfo { hasNextPage endCursor } nodes { ${CARD} } } } }`;
    for (let v = { a: null as string | null, d: null as string | null, moreA: true, moreD: true }; v.moreA || v.moreD;) {
      const p = projectOf(await graphql(
        token,
        `query($owner: String!, $n: Int!, $active: String!, $done: String!, $a: String, $d: String, $moreA: Boolean!, $moreD: Boolean!) { repositoryOwner(login: $owner) { ... on ProjectV2Owner { projectV2(number: $n) { url active: items(first: 100, after: $a, query: $active) @include(if: $moreA) ${page} done: items(first: 100, after: $d, query: $done) @include(if: $moreD) ${page} } } } }`,
        { owner, n: number, active: ACTIVE, done: DONE, ...v },
      ), owner, number);
      for (const n of [...(p.active?.nodes ?? []), ...(p.done?.nodes ?? [])]) {
        const c = n.content;
        const state = n.fieldValueByName && columnState(n.fieldValueByName.name);
        if (c?.number !== undefined && state) cards.push({ state, repo: c.repository.nameWithOwner, number: c.number, title: c.title, url: c.url, updatedAt: n.updatedAt, boardUrl: p.url, closed: c.state === "CLOSED" });
      }
      v = { a: p.active?.pageInfo.endCursor ?? null, d: p.done?.pageInfo.endCursor ?? null, moreA: !!p.active?.pageInfo.hasNextPage, moreD: !!p.done?.pageInfo.hasNextPage };
    }
    return cards;
  }

  // The details of every card outside Done, by url: risk, open PR, and the blockers of an open ready one.
  async function boardDetails(token: string, owner: string, number: number) {
    const out = new Map<string, Details>();
    for (let after: string | null = null; ;) {
      const items: any = projectOf(await graphql(
        token,
        // first: 25, not 100: GitHub prices a query by its page sizes, nested ones multiplied, so this costs 2 points, not 7.
        `query($owner: String!, $n: Int!, $q: String!, $after: String) { repositoryOwner(login: $owner) { ... on ProjectV2Owner { projectV2(number: $n) { items(first: 25, after: $after, query: $q) { pageInfo { hasNextPage endCursor } nodes { ${CARD} labels(first: 20) { nodes { name } } closedByPullRequestsReferences(first: 5, includeClosedPrs: false) { nodes { url mergeable mergeStateStatus commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } } } } } } } } }`,
        { owner, n: number, q: ACTIVE, after },
      ), owner, number).items;
      await Promise.all(items.nodes.map(async (n: any) => {
        const c = n.content;
        if (c?.url === undefined) return;
        const ready = c.state === "OPEN" && n.fieldValueByName && columnState(n.fieldValueByName.name) === "ready";
        out.set(c.url, { risk: triageRisk((c.labels?.nodes ?? []).map((l: { name: string }) => l.name)), ...changeOfPrs(c.closedByPullRequestsReferences?.nodes ?? []), blockedBy: ready ? await blockers(token, c.url).catch(() => undefined) : undefined });
      }));
      if (!items.pageInfo.hasNextPage) return out;
      after = items.pageInfo.endCursor;
    }
  }

  return {
    name: "GitHub",

    async rows(targets, fresh = false) {
      if (fresh) kept.clear();
      const token = process.env.GITHUB_READ_TOKEN;
      if (!token) throw new NotSetUp("Set GITHUB_READ_TOKEN to see the GitHub targets.");
      const boards = new Map<string, Promise<[Card[], Map<string, Details>]>>();
      const lists = targets.map(async (t): Promise<BoardRow[]> => {
        const repo = t.githubRepo!;
        if (t.githubProject === undefined) {
          // 8 REST calls per read, so the labeled issues are read at most every DETAILS_MS too.
          return every(`labels ${repo}`, async () => {
            const per = await Promise.all(STATES.map(async (state) => ((await rest(token, `/repos/${repo}/issues?labels=factory_${state}&state=all&sort=updated&per_page=100`)) as any[])
              .filter((i) => !i.pull_request)
              .map((i) => ({ target: t.name, ticket: String(i.number), title: i.title, state, url: i.html_url, updatedAt: i.updated_at, risk: triageRisk(i.labels.map((l: { name: string }) => l.name)), boardUrl: `${web()}/${repo}/issues`, closed: i.state === "closed" }))));
            // GitHub's "blocked by" issues (factory/adapters/github-tracker.ts).
            return addBlockers(per.flat(), (r) => blockers(token, r.url));
          });
        }
        const owner = repo.split("/")[0];
        const key = `${owner}/${t.githubProject}`;
        if (!boards.has(key)) boards.set(key, Promise.all([boardCards(token, owner, t.githubProject), every(key, () => boardDetails(token, owner, t.githubProject!))]));
        const [cards, details] = await boards.get(key)!;
        return cards.filter((c) => c.repo === repo).map((c) => ({ target: t.name, ticket: String(c.number), title: c.title, state: c.state, url: c.url, updatedAt: c.updatedAt, boardUrl: c.boardUrl, closed: c.closed, ...details.get(c.url) }));
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
