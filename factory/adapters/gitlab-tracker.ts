import { fingerprintMarker, isRequest } from "../conversation";
import { DEVELOPER, GitLab, type StateLabel } from "../gitlab";
import { ticketOfBranch, type FactoryEvent, type FactoryState, type Mark, type Ticket, type Tracker } from "../seams";

const READY = "factory_ready";
const MARK_LABELS: Record<Mark, string> = {
  watcher: "factory_watcher", triaged: "factory_triaged", risk_trivial: "factory_risk_trivial", risk_low: "factory_risk_low", risk_medium: "factory_risk_medium",
  risk_high: "factory_risk_high", implemented: "factory_implemented", reviewed: "factory_reviewed", checked: "factory_checked", risk_checked: "factory_risk_checked",
  merged: "factory_merged", reverted: "factory_reverted",
};
const labelOf = (state: FactoryState) => `factory_${state}` as StateLabel;
const titles = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap((l) => (typeof l?.title === "string" ? [l.title] : [])) : []);
// A person can add factory_ready next to another state label. An active run wins over ready, ready wins over an ended run.
const ENDED = ["needs_info", "blocked", "done"] as const satisfies readonly FactoryState[];
const STATE_ORDER = ["running", "waiting", "stopped", "needs_approval", "ready", ...ENDED] as const satisfies readonly FactoryState[];
const ignored = (reason: "other-project" | "not-added"): FactoryEvent => ({ kind: "ignored", reason });

function toTicket(w: any): Ticket {
  const labels: string[] = w.labels ?? [];
  const state = STATE_ORDER.find((s) => labels.includes(labelOf(s)));
  return {
    ref: String(w.iid),
    title: w.title,
    body: w.description ?? "",
    open: w.state === "opened",
    state,
    ended: state === "ready" ? ENDED.find((s) => labels.includes(labelOf(s))) : undefined,
    marks: (Object.keys(MARK_LABELS) as Mark[]).filter((m) => labels.includes(MARK_LABELS[m])),
    tags: labels.filter((l) => !l.startsWith("factory_")),
    assignees: (w.assignees ?? []).map((a: { username: string }) => a.username),
    url: w.web_url,
  };
}

export function makeGitLabTracker(gitlab: GitLab, projectPath: string): Tracker {
  let project: Promise<number> | undefined;
  let bot: Promise<string> | undefined;
  const projectId = () => (project ??= gitlab.getProject(projectPath).then((p) => p.id));
  const botName = () => (bot ??= gitlab.getJson("/user").then((u: { username: string }) => u.username));
  const issues = async (query: string): Promise<Ticket[]> => (await gitlab.getJson(`/projects/${await projectId()}/issues?${query}`)).map(toTicket);
  const iid = (ref: string) => Number(ref);

  return {
    async ticket(ref) {
      return toTicket(await gitlab.getJson(`/projects/${await projectId()}/issues/${iid(ref)}`));
    },
    async setState(ref, state) {
      await gitlab.setState(await projectId(), iid(ref), labelOf(state));
    },
    async clearState(ref) {
      await gitlab.clearState(await projectId(), iid(ref));
    },
    async mark(ref, mark) {
      await gitlab.addLabel(await projectId(), iid(ref), MARK_LABELS[mark]);
    },
    async unmark(ref, mark) {
      await gitlab.removeLabel(await projectId(), iid(ref), MARK_LABELS[mark]);
    },
    async comment(ref, text) {
      await gitlab.comment(await projectId(), iid(ref), text);
    },
    async assign(ref, person) {
      await gitlab.assignWorkItem(await projectId(), iid(ref), await gitlab.userId(person));
    },
    async close(ref) {
      await gitlab.closeWorkItem(await projectId(), iid(ref));
    },
    async reopen(ref) {
      await gitlab.reopenWorkItem(await projectId(), iid(ref));
    },
    list: (state) => issues(`labels=${labelOf(state)}&state=opened&order_by=created_at&sort=asc&per_page=100`),
    listClosed: (count) => issues(`state=closed&order_by=updated_at&sort=desc&per_page=${Math.min(count, 100)}`).then((l) => l.slice(0, count)),
    async listOpen(limit) {
      const out: Ticket[] = [];
      for (let page = 1; out.length < limit; page++) {
        const got = await issues(`state=opened&order_by=created_at&sort=desc&per_page=100&page=${page}`);
        out.push(...got);
        if (got.length < 100) break;
      }
      return out.slice(0, limit);
    },
    isFactory: async (actor) => actor === (await botName()),
    async trusted(actor) {
      if (actor === (await botName())) return false;
      return (await gitlab.memberAccessLevel(await projectId(), await gitlab.userId(actor))) >= DEVELOPER;
    },
    async startedBy(ref) {
      const id = await gitlab.labelAddedBy(await projectId(), iid(ref), READY);
      return id === undefined ? undefined : (await gitlab.getJson(`/users/${id}`)).username;
    },
    async comments(ref, since) {
      const bot = await botName();
      const notes = await gitlab.getJson(`/projects/${await projectId()}/issues/${iid(ref)}/notes?sort=desc&order_by=created_at&per_page=100`);
      return notes
        .filter((n: any) => !n.system && (!since || n.created_at > since))
        .map((n: any) => ({ author: n.author.username, byFactory: n.author.username === bot, body: n.body, at: n.created_at }));
    },
    parseEvent(payload) {
      const p = payload as any;
      const path = p?.project?.path_with_namespace;
      if (typeof path === "string" && path !== projectPath) return ignored("other-project");
      const actor = p?.user?.username;
      if (typeof path !== "string" || typeof actor !== "string") return ignored("not-added");
      const a = p.object_attributes;
      if (p.object_kind === "issue" || p.object_kind === "work_item") {
        const change = p.changes?.labels;
        if (!change || !titles(change.current).includes(READY) || titles(change.previous).includes(READY) || typeof a?.iid !== "number") return ignored("not-added");
        return { kind: "ready", ticket: String(a.iid), actor };
      }
      // A person's note with the line `@factory stop` or `@factory resume`, or a `@factory` request. The event step decides who may.
      if (p.object_kind === "note" && a?.noteable_type === "Issue" && !a.system && typeof p.issue?.iid === "number") {
        const command = String(a.note ?? "").split("\n").map((l) => l.trim().toLowerCase()).find((l) => l === "@factory stop" || l === "@factory resume");
        if (command) return { kind: "command", ticket: String(p.issue.iid), actor, command: command === "@factory stop" ? "stop" : "resume" };
        if (isRequest(String(a.note ?? ""))) return { kind: "request", ticket: String(p.issue.iid), actor };
        return ignored("not-added");
      }
      // A request on a factory change (branch factory/<ticket>-<slug>). A fork's change never counts.
      if (p.object_kind === "note" && a?.noteable_type === "MergeRequest" && !a.system) {
        const ticket = ticketOfBranch(String(p.merge_request?.source_branch ?? ""));
        const mr = p.merge_request;
        if (ticket && typeof mr.iid === "number" && mr.source_project_id === mr.target_project_id && isRequest(String(a.note ?? ""))) return { kind: "request", ticket, actor, change: String(mr.iid) };
        return ignored("not-added");
      }
      // A merge of a factory change (branch factory/<ticket>-<slug>). An approval starts nothing.
      if (p.object_kind === "merge_request" && a?.action === "merge") {
        const ticket = ticketOfBranch(String(a.source_branch ?? ""));
        if (ticket && typeof a.iid === "number") return { kind: "merged", ticket, change: String(a.iid), actor };
      }
      return ignored("not-added");
    },
    async create(draft) {
      const labels = [...draft.marks.map((m) => MARK_LABELS[m]), ...(draft.state ? [labelOf(draft.state)] : [])];
      const w = await gitlab.createWorkItem(await projectId(), draft.title, `${draft.body}\n\n${fingerprintMarker(draft.fingerprint)}`, labels);
      return { ref: String(w.iid), url: w.webUrl };
    },
    async findOpen(fingerprint) {
      const found = await issues(`labels=${MARK_LABELS.watcher}&state=opened&search=${encodeURIComponent(fingerprint)}&per_page=100`);
      return found.find((t) => t.body.includes(fingerprintMarker(fingerprint)))?.ref;
    },
    async createdSince(mark, since) {
      return gitlab.countCreatedSince(await projectId(), MARK_LABELS[mark], since);
    },
  };
}
