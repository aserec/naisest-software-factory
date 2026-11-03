// The dashboard's GitHub reads, with the server's GITHUB_READ_TOKEN: the board rows of GitHub targets and a user's role.
import type { TargetInfo } from "./targets";

type FetchFn = typeof fetch;
export interface BoardRow { target: string; ticket: string; title: string; state: string; url: string; updatedAt: string }

const STATES = ["ready", "running", "waiting", "needs_info", "needs_approval", "done", "stopped", "blocked"];
const columnState = (name: string) => name.trim().toLowerCase().replace(/\s+/g, "_");

export function makeGitHub(fetchFn: FetchFn = fetch) {
  const headers = () => ({ Authorization: `Bearer ${process.env.GITHUB_READ_TOKEN ?? ""}`, Accept: "application/vnd.github+json" });
  const rest = async (path: string) => {
    const r = await fetchFn(`https://api.github.com${path}`, { headers: headers() });
    if (!r.ok) throw new Error(`GitHub ${r.status} for ${path.split("?")[0]}`);
    return r.json();
  };
  const graphql = async (query: string, variables: object) => {
    const r = await fetchFn("https://api.github.com/graphql", { method: "POST", headers: headers(), body: JSON.stringify({ query, variables }) });
    const j = r.ok ? await r.json() : undefined;
    if (!j || j.errors?.length) throw new Error(`GitHub GraphQL failed with status ${r.status}`);
    return j.data;
  };

  // Every card of one board, read once for all targets that share it. ponytail: reads the whole board; filter with items(query:) if it grows past a few thousand cards.
  async function boardCards(owner: string, number: number) {
    const cards: { status: string; repo: string; number: number; title: string; url: string; updatedAt: string }[] = [];
    for (let after: string | null = null; ;) {
      const d = await graphql(
        `query($owner: String!, $n: Int!, $after: String) { repositoryOwner(login: $owner) { ... on ProjectV2Owner { projectV2(number: $n) { items(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { updatedAt fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } } content { ... on Issue { number title url state repository { nameWithOwner } } } } } } } } }`,
        { owner, n: number, after },
      );
      const items = d.repositoryOwner?.projectV2?.items;
      if (!items) throw new Error(`GitHub project ${owner}/${number} not found`);
      for (const n of items.nodes) {
        const c = n.content;
        if (c?.state === "OPEN" && n.fieldValueByName) cards.push({ status: columnState(n.fieldValueByName.name), repo: c.repository.nameWithOwner, number: c.number, title: c.title, url: c.url, updatedAt: n.updatedAt });
      }
      if (!items.pageInfo.hasNextPage) return cards;
      after = items.pageInfo.endCursor;
    }
  }

  return {
    // Rows in the GitLab board's shape: the state is the factory_* name.
    async board(targets: TargetInfo[]): Promise<BoardRow[]> {
      const boards = new Map<string, ReturnType<typeof boardCards>>();
      const lists = targets.filter((t) => t.github).map(async (t) => {
        const { repo, project } = t.github!;
        if (project === undefined) {
          const per = await Promise.all(STATES.map(async (s) => ((await rest(`/repos/${repo}/issues?labels=factory_${s}&state=open&per_page=100`)) as any[])
            .filter((i) => !i.pull_request)
            .map((i) => ({ target: t.name, ticket: String(i.number), title: i.title, state: `factory_${s}`, url: i.html_url, updatedAt: i.updated_at }))));
          return per.flat();
        }
        const owner = repo.split("/")[0];
        const key = `${owner}/${project}`;
        if (!boards.has(key)) boards.set(key, boardCards(owner, project));
        return (await boards.get(key)!)
          .filter((c) => c.repo === repo && STATES.includes(c.status))
          .map((c) => ({ target: t.name, ticket: String(c.number), title: c.title, state: `factory_${c.status}`, url: c.url, updatedAt: c.updatedAt }));
      });
      return (await Promise.all(lists)).flat();
    },

    // Write, maintain or admin on any GitHub target's repo. False when GitHub says no or does not answer.
    async canWrite(login: string, targets: TargetInfo[]): Promise<boolean> {
      for (const t of targets.filter((x) => x.github)) {
        const p = await rest(`/repos/${t.github!.repo}/collaborators/${encodeURIComponent(login)}/permission`).catch(() => undefined);
        if (p?.permission === "admin" || p?.permission === "write") return true; // maintain shows as write
      }
      return false;
    },
  };
}
