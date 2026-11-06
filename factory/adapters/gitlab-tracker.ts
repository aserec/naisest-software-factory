import { isNotFound } from "../errors";
import { AI_LINE, commandIn, fingerprintMarker, isRequest, noQuickActions } from "../conversation";
import { confirmedRelays, withRelays } from "../relay";
import { GitLab, refuseSecrets } from "../gitlab";
import { ENDED_STATES, STATE_ORDER, ticketOfBranch, type FactoryEvent, type FactoryState, type Mark, type Ticket, type Tracker } from "../seams";

const READY = "factory_ready";
// GitLab access level of the Developer role. Developers and above may command the factory.
const DEVELOPER = 30;
const MARK_LABELS: Record<Mark, string> = {
  watcher: "factory_watcher", triaged: "factory_triaged", risk_trivial: "factory_risk_trivial", risk_low: "factory_risk_low", risk_medium: "factory_risk_medium",
  risk_high: "factory_risk_high", implemented: "factory_implemented", reviewed: "factory_reviewed", checked: "factory_checked", risk_checked: "factory_risk_checked",
  merged: "factory_merged", reverted: "factory_reverted",
};
const labelOf = (state: FactoryState) => `factory_${state}`;
const titles = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap((l) => (typeof l?.title === "string" ? [l.title] : [])) : []);
// A work item holds at most one state label: setting one removes all the others.
const STATE_LABELS = STATE_ORDER.map(labelOf);
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
    ended: state === "ready" ? ENDED_STATES.find((s) => labels.includes(labelOf(s))) : undefined,
    marks: (Object.keys(MARK_LABELS) as Mark[]).filter((m) => labels.includes(MARK_LABELS[m])),
    tags: labels.filter((l) => !l.startsWith("factory_")),
    assignees: (w.assignees ?? []).map((a: { username: string }) => a.username),
    url: w.web_url,
  };
}

// relayUser: the Teams relay bot (relay.ts). Its comments count only through a person's 👍.
export function makeGitLabTracker(gitlab: GitLab, projectPath: string, relayUser?: string): Tracker {
  let project: Promise<number> | undefined;
  const projectId = () => (project ??= gitlab.getJson(`/projects/${encodeURIComponent(projectPath)}`).then((p: { id: number }) => p.id));
  const issues = async (query: string): Promise<Ticket[]> => (await gitlab.getJson(`/projects/${await projectId()}/issues?${query}`)).map(toTicket);
  const iid = (ref: string) => Number(ref);
  const issueUrl = async (ref: string) => `/projects/${await projectId()}/issues/${iid(ref)}`;
  const update = async (ref: string, body: unknown) => void (await gitlab.call("PUT", await issueUrl(ref), body));
  const userId = async (username: string): Promise<number> => {
    const list = await gitlab.getJson(`/users?username=${encodeURIComponent(username)}`);
    if (!list[0]) throw new Error(`GitLab user ${username} not found`);
    return list[0].id;
  };

  return {
    async ticket(ref) {
      return toTicket(await gitlab.getJson(await issueUrl(ref)));
    },
    async setState(ref, state) {
      await update(ref, { add_labels: labelOf(state), remove_labels: STATE_LABELS.filter((l) => l !== labelOf(state)).join(",") });
    },
    async clearState(ref) {
      await update(ref, { remove_labels: STATE_LABELS.join(",") });
    },
    async mark(ref, mark) {
      await update(ref, { add_labels: MARK_LABELS[mark] });
    },
    async unmark(ref, mark) {
      await update(ref, { remove_labels: MARK_LABELS[mark] });
    },
    async comment(ref, text) {
      const body = noQuickActions(`${AI_LINE}\n\n${text}`);
      refuseSecrets(body, "Comment");
      await gitlab.call("POST", `${await issueUrl(ref)}/notes`, { body });
    },
    async assign(ref, person) {
      await update(ref, { assignee_ids: [await userId(person)] });
    },
    async close(ref) {
      await update(ref, { state_event: "close" });
    },
    async reopen(ref) {
      await update(ref, { state_event: "reopen" });
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
    isFactory: async (actor) => actor === (await gitlab.botName()),
    async trusted(actor) {
      if (actor === (await gitlab.botName())) return false;
      const [id, project] = [await userId(actor), await projectId()];
      try {
        return (await gitlab.getJson(`/projects/${project}/members/all/${id}`)).access_level >= DEVELOPER;
      } catch (e) {
        if (isNotFound(e)) return false; // not a member
        throw e;
      }
    },
    // The poller has no webhook that names the person, so the label history says who last added factory_ready.
    async startedBy(ref) {
      const events = await gitlab.all<{ action: string; label?: { name: string }; user?: { id: number } }>(`${await issueUrl(ref)}/resource_label_events?per_page=100`);
      const id = events.filter((e) => e.action === "add" && e.label?.name === READY).at(-1)?.user?.id;
      return id === undefined ? undefined : (await gitlab.getJson(`/users/${id}`)).username;
    },
    async comments(ref, since) {
      const bot = await gitlab.botName();
      const url = await issueUrl(ref);
      const notes = (await gitlab.getJson(`${url}/notes?sort=desc&order_by=created_at&per_page=100`)).filter((n: any) => !n.system);
      const own = notes.map((n: any) => ({ author: n.author.username, byFactory: n.author.username === bot, body: n.body, at: n.created_at }));
      // A relay comment older than `since` can have a newer 👍, so relays are read whatever their age.
      const relayed = await Promise.all(notes.filter((n: any) => relayUser && n.author.username === relayUser).map(async (n: any) => {
        const awards = await gitlab.getJson(`${url}/notes/${n.id}/award_emoji?per_page=100`);
        return confirmedRelays({ body: n.body, editedAt: n.updated_at ?? n.created_at }, awards.filter((a: any) => a.name === "thumbsup").map((a: any) => ({ by: a.user.username, at: a.created_at })));
      }));
      return withRelays(own, relayed.flat(), since);
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
        const command = commandIn(String(a.note ?? ""));
        if (command) return { kind: "command", ticket: String(p.issue.iid), actor, command };
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
      const description = noQuickActions(`${draft.body}\n\n${fingerprintMarker(draft.fingerprint)}`);
      refuseSecrets(`${draft.title}\n${description}`, "Work item");
      const w = await (await gitlab.call("POST", `/projects/${await projectId()}/issues`, { title: draft.title, description, labels: labels.join(",") })).json();
      return { ref: String(w.iid), url: w.web_url as string };
    },
    // GitLab's linked issues of type "is blocked by" (a Premium feature; without it the list has none).
    openBlockers: async (ref) => (await gitlab.getJson(`${await issueUrl(ref)}/links`))
      .filter((l: any) => l.link_type === "is_blocked_by" && l.state === "opened").map((l: any) => l.web_url),
    async findOpen(fingerprint) {
      const found = await issues(`labels=${MARK_LABELS.watcher}&state=opened&search=${encodeURIComponent(fingerprint)}&per_page=100`);
      return found.find((t) => t.body.includes(fingerprintMarker(fingerprint)))?.ref;
    },
    async createdSince(mark, since) {
      const res = await gitlab.call("GET", `/projects/${await projectId()}/issues?labels=${MARK_LABELS[mark]}&created_after=${encodeURIComponent(since.toISOString())}&per_page=1`);
      // Fail closed: a missing count would read as 0 and let the daily cap pass.
      const total = res.headers.get("X-Total")?.trim();
      if (!total || !Number.isFinite(Number(total))) throw new Error(`GitLab sent no usable X-Total count: ${JSON.stringify(total)}`);
      return Number(total);
    },
  };
}
