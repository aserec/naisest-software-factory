// Tickets are GitHub issues. Marks are always labels. The state is a factory_* label, or, with a board,
// the issue's Status column on a GitHub Projects board (column "Needs info" is state needs_info).
import { errText, isNotFound } from "../errors";
import { AI_LINE, commandIn, fingerprintMarker } from "../conversation";
import type { GitHub } from "../github";
import { confirmedRelays, withRelays } from "../relay";
import { findSecrets } from "../rules";
import { ENDED_STATES, STATE_ORDER, ticketOfBranch, type FactoryEvent, type FactoryState, type Mark, type Ticket, type Tracker } from "../seams";

const READY = "factory_ready";
const MARKS: Mark[] = ["watcher", "triaged", "risk_trivial", "risk_low", "risk_medium", "risk_high", "implemented", "reviewed", "checked", "risk_checked", "merged", "reverted"];
const markLabel = (m: Mark) => `factory_${m}`;
const labelOf = (state: FactoryState) => `factory_${state}`;
const STATE_LABELS = STATE_ORDER.map(labelOf);
const columnState = (name: string) => name.trim().toLowerCase().replace(/\s+/g, "_") as FactoryState;
const ignored = (reason: "other-project" | "not-added"): FactoryEvent => ({ kind: "ignored", reason });
const checked = (text: string) => {
  if (findSecrets(text).length > 0) throw new Error("Refused: the text contains a secret");
  return text;
};

// An issue in plain fields, from REST or GraphQL.
interface Issue { number: number; title: string; body: string | null; open: boolean; labels: string[]; assignees: string[]; url: string; createdAt: string }
// The fields of GitHub's JSON the factory reads.
type Login = { login: string };
interface RestIssue { number: number; title: string; body: string | null; state: string; html_url: string; created_at: string; labels?: (string | { name: string })[]; assignees?: Login[]; pull_request?: unknown; repository_url?: string }
interface GraphIssue { number: number; title: string; body: string | null; state: string; url: string; createdAt: string; labels: { nodes: { name: string }[] }; assignees: { nodes: Login[] } }
interface RestComment { id: number; user: Login; body: string | null; created_at: string; updated_at?: string; reactions?: Record<string, number> }
const fromRest = (i: RestIssue): Issue => ({
  number: i.number, title: i.title, body: i.body, open: i.state === "open", url: i.html_url, createdAt: i.created_at,
  labels: (i.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)), assignees: (i.assignees ?? []).map((a) => a.login),
});

function toTicket(i: Issue, boardState?: FactoryState | null): Ticket {
  const fromLabels = STATE_ORDER.find((s) => i.labels.includes(labelOf(s)));
  const state = boardState === undefined ? fromLabels : boardState ?? undefined;
  return {
    ref: String(i.number), title: i.title, body: i.body ?? "", open: i.open, state,
    ended: boardState === undefined && state === "ready" ? ENDED_STATES.find((s) => i.labels.includes(labelOf(s))) : undefined,
    marks: MARKS.filter((m) => i.labels.includes(markLabel(m))),
    tags: i.labels.filter((l) => !l.startsWith("factory_")),
    assignees: i.assignees, url: i.url,
  };
}

const ISSUE_FIELDS = "number title body state url createdAt labels(first: 50) { nodes { name } } assignees(first: 20) { nodes { login } } repository { nameWithOwner }";
const STATUS = `fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }`;
const fromGraph = (c: GraphIssue): Issue => ({
  number: c.number, title: c.title, body: c.body, open: c.state === "OPEN", url: c.url, createdAt: c.createdAt,
  labels: c.labels.nodes.map((l) => l.name), assignees: c.assignees.nodes.map((a) => a.login),
});

// The board: a GitHub Projects (v2) board with a single-select Status field whose columns are factory states.
function makeBoard(gh: GitHub, repo: string, number: number) {
  const [owner, name] = repo.split("/");
  type Project = { id: string; field: string; options: { id: string; name: string }[] };
  let found: Promise<Project> | undefined;
  const project = (): Promise<Project> => (found ??= gh.graphql(
    `query($owner: String!, $n: Int!) { repositoryOwner(login: $owner) { ... on ProjectV2Owner { projectV2(number: $n) { id field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name } } } } } } }`,
    { owner, n: number },
  ).then((d) => {
    const p = d.repositoryOwner?.projectV2;
    if (!p?.field?.id) throw new Error(`GitHub project ${owner}/${number} not found, or it has no Status field`);
    return { id: p.id, field: p.field.id, options: p.field.options };
  }).catch((e) => {
    found = undefined; // a failed lookup is tried again on the next call, not kept for the whole run
    throw e;
  }));
  // The issue, its node id, and its card on this board, if any.
  const item = async (ref: string) => {
    const { id } = await project();
    const d = await gh.graphql(
      `query($owner: String!, $name: String!, $n: Int!) { repository(owner: $owner, name: $name) { issue(number: $n) { id ${ISSUE_FIELDS} projectItems(first: 50) { nodes { id project { id } ${STATUS} } } } } }`,
      { owner, name, n: Number(ref) },
    );
    const issue = d.repository.issue;
    const card = (issue.projectItems.nodes as { id: string; project: { id: string }; fieldValueByName: unknown }[]).find((n) => n.project.id === id);
    return { issue, card, status: card?.fieldValueByName as { name: string } | null | undefined };
  };
  return {
    async ticket(ref: string) {
      const { issue, status } = await item(ref);
      return toTicket(fromGraph(issue), status ? columnState(status.name) : null);
    },
    async setState(ref: string, state: FactoryState) {
      const p = await project();
      const option = p.options.find((o) => columnState(o.name) === state);
      if (!option) throw new Error(`The GitHub project's Status field has no column for ${state}`);
      const { issue, card } = await item(ref);
      const itemId = card?.id ?? (await gh.graphql(`mutation($p: ID!, $c: ID!) { addProjectV2ItemById(input: { projectId: $p, contentId: $c }) { item { id } } }`, { p: p.id, c: issue.id })).addProjectV2ItemById.item.id;
      await gh.graphql(
        `mutation($p: ID!, $i: ID!, $f: ID!, $o: String!) { updateProjectV2ItemFieldValue(input: { projectId: $p, itemId: $i, fieldId: $f, value: { singleSelectOptionId: $o } }) { projectV2Item { id } } }`,
        { p: p.id, i: itemId, f: p.field, o: option.id },
      );
    },
    async clearState(ref: string) {
      const p = await project();
      const { card } = await item(ref);
      if (!card) return; // not on the board, so no state
      await gh.graphql(
        `mutation($p: ID!, $i: ID!, $f: ID!) { clearProjectV2ItemFieldValue(input: { projectId: $p, itemId: $i, fieldId: $f }) { projectV2Item { id } } }`,
        { p: p.id, i: card.id, f: p.field },
      );
    },
    // ponytail: reads every card each call; filter with the items(query:) argument if boards grow past a few thousand cards.
    async list(state: FactoryState) {
      const { id } = await project();
      const out: Issue[] = [];
      for (let after: string | null = null; ;) {
        const d = await gh.graphql(
          `query($id: ID!, $after: String) { node(id: $id) { ... on ProjectV2 { items(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${STATUS} content { ... on Issue { ${ISSUE_FIELDS} } } } } } } }`,
          { id, after },
        );
        const items = d.node.items;
        for (const n of items.nodes) {
          const c = n.content;
          if (c?.repository?.nameWithOwner === repo && c.state === "OPEN" && n.fieldValueByName && columnState(n.fieldValueByName.name) === state) out.push(fromGraph(c));
        }
        if (!items.pageInfo.hasNextPage) break;
        after = items.pageInfo.endCursor;
      }
      return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((i) => toTicket(i, state));
    },
    // Who made the issue's last Status change on this board, if it moved the card to Ready. The Status value's own
    // creator is whoever first set the field (often the board's automation), not who moved the card last.
    async startedBy(ref: string) {
      const { id } = await project();
      const d = await gh.graphql(
        `query($owner: String!, $name: String!, $n: Int!) { repository(owner: $owner, name: $name) { issue(number: $n) { timelineItems(last: 50, itemTypes: [PROJECT_V2_ITEM_STATUS_CHANGED_EVENT]) { nodes { ... on ProjectV2ItemStatusChangedEvent { actor { login } status project { id } } } } } } }`,
        { owner, name, n: Number(ref) },
      );
      const last = d.repository.issue.timelineItems.nodes.filter((n: { project?: { id: string } }) => n.project?.id === id).at(-1) as { status: string; actor?: Login } | undefined;
      return last && columnState(last.status) === "ready" ? last.actor?.login : undefined;
    },
  };
}

// sharedAccount: the token's account is also a person's (a trial before the factory has its own account). That
// person's Ready, merges by hand and comments then count; the factory's own comments are told apart by the AI line.
// relayUser: the Teams relay bot (relay.ts). Its comments count only through a person's 👍.
export function makeGitHubTracker(gh: GitHub, repo: string, projectNumber?: number, sharedAccount = false, relayUser?: string): Tracker {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`GitHub repo must be owner/name, got ${repo}`);
  const base = `/repos/${repo}/issues`;
  // The issues endpoint also lists pull requests.
  const issues = async (query: string) => (await gh.all<RestIssue>(`${base}?${query}&per_page=100`)).filter((i) => !i.pull_request).map(fromRest);
  const board = projectNumber === undefined ? undefined : makeBoard(gh, repo, projectNumber);
  const addLabels = (ref: string, labels: string[]) => gh.call("POST", `${base}/${Number(ref)}/labels`, { labels });
  const removeLabel = async (ref: string, label: string) => {
    await gh.call("DELETE", `${base}/${Number(ref)}/labels/${encodeURIComponent(label)}`).catch((e) => {
      if (!isNotFound(e)) throw e; // the label was not there
    });
  };

  return {
    ticket: async (ref) => board ? board.ticket(ref) : toTicket(fromRest(await gh.json("GET", `${base}/${Number(ref)}`))),
    async setState(ref, state) {
      if (board) return board.setState(ref, state);
      const has = fromRest(await gh.json("GET", `${base}/${Number(ref)}`)).labels;
      for (const l of has.filter((l) => STATE_LABELS.includes(l) && l !== labelOf(state))) await removeLabel(ref, l);
      await addLabels(ref, [labelOf(state)]); // GitHub creates a missing label
    },
    async clearState(ref) {
      if (board) return board.clearState(ref);
      const has = fromRest(await gh.json("GET", `${base}/${Number(ref)}`)).labels;
      for (const l of has.filter((l) => STATE_LABELS.includes(l))) await removeLabel(ref, l);
    },
    mark: async (ref, mark) => void (await addLabels(ref, [markLabel(mark)])),
    unmark: (ref, mark) => removeLabel(ref, markLabel(mark)),
    comment: async (ref, text) => void (await gh.call("POST", `${base}/${Number(ref)}/comments`, { body: checked(`${AI_LINE}\n\n${text}`) })),
    assign: async (ref, person) => void (await gh.call("PATCH", `${base}/${Number(ref)}`, { assignees: [person] })),
    close: async (ref) => void (await gh.call("PATCH", `${base}/${Number(ref)}`, { state: "closed" })),
    reopen: async (ref) => void (await gh.call("PATCH", `${base}/${Number(ref)}`, { state: "open" })),
    list: (state) => board ? board.list(state) : issues(`labels=${labelOf(state)}&state=open&sort=created&direction=asc`).then((l) => l.map((i) => toTicket(i))),
    async listClosed(count) {
      const page: RestIssue[] = await gh.json("GET", `${base}?state=closed&sort=updated&direction=desc&per_page=${Math.min(count, 100)}`);
      return page.filter((i) => !i.pull_request).map((i) => toTicket(fromRest(i))).slice(0, count);
    },
    // gh.all would read every page; this stops at the limit. A short page is the last one (pull requests count in it).
    async listOpen(limit) {
      const out: Ticket[] = [];
      for (let page = 1; out.length < limit; page++) {
        const got: RestIssue[] = await gh.json("GET", `${base}?state=open&sort=created&direction=desc&per_page=100&page=${page}`);
        out.push(...got.filter((i) => !i.pull_request).map((i) => toTicket(fromRest(i))));
        if (got.length < 100) break;
      }
      return out.slice(0, limit);
    },
    isFactory: async (actor) => actor === (await gh.botName()),
    async trusted(actor) {
      if (actor === (await gh.botName()) && !sharedAccount) return false;
      // 404: no such user. Any other failure (a 5xx, a rate limit) throws, so the caller tries again next poll.
      const p = await gh.json("GET", `/repos/${repo}/collaborators/${encodeURIComponent(actor)}/permission`).catch((e) => {
        if (isNotFound(e)) return undefined;
        console.log(`Reading the permission of ${actor} failed: ${errText(e)}`);
        throw e;
      });
      return p?.permission === "admin" || p?.permission === "write"; // maintain shows as write
    },
    async startedBy(ref) {
      if (board) return board.startedBy(ref);
      const events = await gh.all<{ event: string; label?: { name: string }; actor?: Login }>(`${base}/${Number(ref)}/events?per_page=100`);
      return events.filter((e) => e.event === "labeled" && e.label?.name === READY).at(-1)?.actor?.login;
    },
    async comments(ref, since) {
      const name = await gh.botName();
      // GitHub's since filters on the edit time; withRelays keeps only comments created after it, newest first.
      // A relay comment older than `since` can have a newer 👍, so with a relay bot every comment is read.
      const all = await gh.all<RestComment>(`${base}/${Number(ref)}/comments?per_page=100${since && !relayUser ? `&since=${encodeURIComponent(since)}` : ""}`);
      const own = all.map((c) => ({ author: c.user.login, byFactory: c.user.login === name && (!sharedAccount || String(c.body ?? "").startsWith(AI_LINE)), body: c.body ?? "", at: c.created_at })).reverse();
      const relayed = await Promise.all(all.filter((c) => relayUser && c.user.login === relayUser && (c.reactions?.["+1"] ?? 0) > 0).map(async (c) => {
        const up = await gh.all<{ user: Login; created_at: string }>(`/repos/${repo}/issues/comments/${c.id}/reactions?content=%2B1&per_page=100`);
        return confirmedRelays({ body: c.body ?? "", editedAt: c.updated_at ?? c.created_at }, up.map((r) => ({ by: r.user.login, at: r.created_at })));
      }));
      return withRelays(own, relayed.flat(), since);
    },
    // GitHub webhook payloads: a factory_ready label added, an `@factory stop|resume` comment, a merged factory PR.
    parseEvent(payload) {
      const p = payload as any;
      const path = p?.repository?.full_name;
      if (typeof path === "string" && path !== repo) return ignored("other-project");
      const actor = p?.sender?.login;
      if (typeof path !== "string" || typeof actor !== "string") return ignored("not-added");
      if (p.issue && !p.issue.pull_request && typeof p.issue.number === "number") {
        if (p.action === "labeled" && p.label?.name === READY && !board) return { kind: "ready", ticket: String(p.issue.number), actor };
        if (p.action === "created" && p.comment) {
          const command = commandIn(String(p.comment.body ?? ""));
          if (command) return { kind: "command", ticket: String(p.issue.number), actor, command };
        }
      }
      if (p.pull_request && p.action === "closed" && p.pull_request.merged) {
        const ticket = ticketOfBranch(String(p.pull_request.head?.ref ?? ""));
        if (ticket) return { kind: "merged", ticket, change: String(p.pull_request.number), actor };
      }
      return ignored("not-added");
    },
    async create(draft) {
      const labels = [...draft.marks.map(markLabel), ...(draft.state && !board ? [labelOf(draft.state)] : [])];
      const i = await gh.json("POST", base, { title: checked(draft.title), body: checked(`${draft.body}\n\n${fingerprintMarker(draft.fingerprint)}`), labels });
      if (draft.state && board) await board.setState(String(i.number), draft.state);
      return { ref: String(i.number), url: i.html_url };
    },
    // GitHub's issue dependencies ("blocked by"). A blocker in another repo shows as owner/name#n.
    openBlockers: async (ref) => (await gh.all<RestIssue>(`${base}/${Number(ref)}/dependencies/blocked_by?per_page=100`))
      .filter((i) => i.state === "open").map((i) => (i.repository_url?.endsWith(`/repos/${repo}`) ? String(i.number) : i.html_url)),
    async findOpen(fingerprint) {
      const found = await issues(`labels=${markLabel("watcher")}&state=open`);
      return found.find((i) => (i.body ?? "").includes(fingerprintMarker(fingerprint)))?.number.toString();
    },
    // `since` on the issues list is the update time: an issue created after the date was also updated after it.
    async createdSince(mark, since) {
      const found = await issues(`labels=${markLabel(mark)}&state=all&since=${encodeURIComponent(since.toISOString())}`);
      return found.filter((i) => Date.parse(i.createdAt) >= since.getTime()).length;
    },
  };
}
