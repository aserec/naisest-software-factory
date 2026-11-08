import type { RunRecord } from "./record";
import { AI_LINE, later, noQuickActions } from "./conversation";
import { HttpError } from "./errors";
import { findSecrets } from "./rules";
import { defaultSwitches, type EventType } from "./run-events";
import { changeBranchPrefix, ticketOfBranch, NotFactoryRunError } from "./seams";
import type { AgentPlan, Change, ChangeRef, Checks, Chat, CiRunner, CodeHost, Comment, ControlState, Dashboard, Dispatch, FactoryEvent, FactoryState, Harness, HarnessJob, HarnessResult, Judge, JevAnswer, JevQuestion, LogSource, ErrorGroup, Mark, Notice, PersonRef, Repo, RunEvent, RunVars, Ticket, TicketDraft, TicketRef, Tracker, ToolCall } from "./seams";

export const FAKE_FACTORY: PersonRef = "factory-bot";

// An in-memory Tracker for tests. It keeps the rules of the real one: secrets are refused, the factory is not trusted.
export function fakeTracker(seed: Partial<Ticket>[] = []): Tracker & { tickets: Map<TicketRef, Ticket>; blockers: Map<TicketRef, TicketRef[]>; posted: { ref: TicketRef; text: string }[]; created: TicketDraft[]; cleared: TicketRef[]; say(ref: TicketRef, author: PersonRef, body: string, at?: string): void } {
  const tickets = new Map<TicketRef, Ticket>();
  const notes = new Map<TicketRef, Comment[]>();
  const fingerprints = new Map<TicketRef, string>();
  const posted: { ref: TicketRef; text: string }[] = [];
  const created: TicketDraft[] = [];
  const cleared: TicketRef[] = [];
  const blockers = new Map<TicketRef, TicketRef[]>(); // ticket -> the tickets that block it
  const add = (t: Partial<Ticket>): Ticket => {
    const ref = t.ref ?? String(tickets.size + 1);
    const ticket: Ticket = { title: "", body: "", open: true, marks: [], tags: [], assignees: [], url: `https://tracker.example/${ref}`, ...t, ref };
    tickets.set(ref, ticket);
    return ticket;
  };
  seed.forEach(add);
  const get = (ref: TicketRef) => {
    const t = tickets.get(ref);
    if (!t) throw new HttpError(`No ticket ${ref}`, 404);
    return t;
  };

  return {
    tickets, blockers, posted, created, cleared,
    // A comment from a person, for inbox tests.
    say: (ref, author, body, at = new Date().toISOString()) => void notes.set(ref, [{ author, byFactory: false, body, at }, ...(notes.get(ref) ?? [])]),
    ticket: async (ref) => get(ref),
    setState: async (ref, state: FactoryState) => { get(ref).state = state; },
    clearState: async (ref) => { get(ref).state = undefined; get(ref).ended = undefined; cleared.push(ref); },
    mark: async (ref, mark) => { const t = get(ref); if (!t.marks.includes(mark)) t.marks = [...t.marks, mark]; },
    unmark: async (ref, mark) => { const t = get(ref); t.marks = t.marks.filter((m) => m !== mark); },
    comment: async (ref, text) => {
      get(ref);
      if (findSecrets(text).length > 0) throw new Error("Comment refused: it contains a secret");
      posted.push({ ref, text });
      notes.set(ref, [{ author: FAKE_FACTORY, byFactory: true, body: text, at: new Date().toISOString() }, ...(notes.get(ref) ?? [])]);
    },
    assign: async (ref, person) => { get(ref).assignees = [person]; },
    close: async (ref) => { get(ref).open = false; },
    reopen: async (ref) => { get(ref).open = true; },
    list: async (state) => [...tickets.values()].filter((t) => t.open && t.state === state),
    listClosed: async (count) => [...tickets.values()].filter((t) => !t.open).reverse().slice(0, count),
    listOpen: async (limit) => [...tickets.values()].filter((t) => t.open).reverse().slice(0, limit),
    trusted: async (actor) => actor !== FAKE_FACTORY,
    isFactory: async (actor) => actor === FAKE_FACTORY,
    startedBy: async () => undefined,
    comments: async (ref, since) => (notes.get(get(ref).ref) ?? []).filter((c) => !since || c.at > since),
    // Tests pass an event where the real adapter gets a webhook payload.
    parseEvent: (payload) => payload as FactoryEvent,
    create: async (draft) => {
      created.push(draft);
      const t = add({ title: draft.title, body: draft.body, state: draft.state, marks: draft.marks });
      fingerprints.set(t.ref, draft.fingerprint);
      return { ref: t.ref, url: t.url };
    },
    findOpen: async (fingerprint) => [...tickets.values()].find((t) => t.open && fingerprints.get(t.ref) === fingerprint)?.ref,
    // ponytail: counts every ticket made through create(); they all count as made now. Add dates if a test needs older ones.
    createdSince: async (mark: Mark) => created.filter((d) => d.marks.includes(mark)).length,
    openBlockers: async (ref) => (blockers.get(ref) ?? []).filter((b) => tickets.get(b)?.open ?? true),
  };
}

export interface FakeCodeHostOptions {
  baseBranch?: string;
  target?: string; // the branch the change merges into; default the base branch
  head?: string; // the commit of the change; only this one is ever green or mergeable
  landedSha?: string; // what merge returns
  existing?: boolean; // a change of the branch is already open
  merged?: boolean; // the change is already merged, by a person
  changeChecks?: Checks; // checks of the head
  branchChecks?: Checks;
  repo?: Repo;
  attachFails?: number; // the first n attach calls fail
  behind?: number; // how many times the base branch moves ahead of the change; a rebase uses up one
  rebaseFails?: boolean;
  conflicts?: boolean; // every change opened has conflicts with the base branch; a test can set a change's conflicts later
  diffs?: Record<string, Record<string, string>>; // branchDiff by sha; any other sha gets DIFF
  files?: Record<string, string>; // files at the head of the base branch, for readFile; any other path is undefined
}

export const DIFF = { "src/List.tsx": "@@ -1,2 +1,3 @@\n const a = 1;\n+  if (loading) return <Spinner />;\n" };

// An in-memory CodeHost for tests. It keeps the rules of the real one: the AI line and the closing line,
// no line that starts with "/", secrets refused, merge only of the head, no merge of a change that is behind.
export function fakeCodeHost(o: FakeCodeHostOptions = {}) {
  const head = o.head ?? "head1";
  let behind = o.behind ?? 0;
  const changes = new Map<ChangeRef, Omit<Change, "behind"> & { branch: string; updatedAt?: string }>();
  const byBranch = new Map<string, ChangeRef>();
  const changeNotes = new Map<ChangeRef, Comment[]>(); // newest first
  const edits = new Map<ChangeRef, Awaited<ReturnType<CodeHost["changeEdits"]>>>(); // newest first; tests fill it
  const commits = new Map<ChangeRef, Awaited<ReturnType<CodeHost["changeCommits"]>>>();
  const baseLog: Awaited<ReturnType<CodeHost["baseCommits"]>> = [];
  const attached: { name: string; size: number }[] = [];
  let attachCalls = 0;
  const open = (branch: string, title: string, body: string, ticket?: TicketRef) => {
    const text = noQuickActions([AI_LINE, ...(ticket ? [`Closes #${ticket}`] : []), body].join("\n\n"));
    const ref = byBranch.get(branch) ?? String(changes.size + 5);
    byBranch.set(branch, ref);
    const was = changes.get(ref);
    changes.set(ref, { ref, branch, title, body: text, open: !o.merged, merged: !!o.merged, head, landedSha: o.landedSha ?? "landed1", target: o.target ?? o.baseBranch ?? "develop", url: `https://host.example/changes/${ref}`, conflicts: was?.conflicts ?? !!o.conflicts });
    return { ref, was: !!was };
  };
  const get = (ref: ChangeRef) => {
    const c = changes.get(ref);
    if (!c) throw new Error(`No change ${ref}`);
    return c;
  };
  const host = {
    changes, // every change by ref, the newest last
    edits,
    commits,
    baseLog, // the base branch's commits, newest first; tests fill it
    // A person closes the change on the host, without the factory.
    close: (ref: ChangeRef, by?: PersonRef) => void Object.assign(get(ref), { open: false, merged: false, closedBy: by }),
    // A person merges the change on the host, without the factory.
    mergeByPerson: (ref: ChangeRef, at?: string) => void Object.assign(get(ref), { open: false, merged: true, mergedAt: at }),
    mrComments: [] as string[],
    mrTitle: "",
    mrDescription: "",
    mrOpened: false,
    merged: false,
    mergedSha: "",
    mergeMessage: "",
    revertOpened: false,
    mainPipelineRef: "",
    assigned: [] as { ref: ChangeRef; person: PersonRef }[],
    attached, // uploads that worked
    get attachCalls() { return attachCalls; }, // every attach call, failed or not
    baseBranch: async () => o.baseBranch ?? "develop",
    cloneAt: () => {
      if (!o.repo) throw new Error("This fake code host has no repo");
      return o.repo;
    },
    openChange: async (branch: string, title: string, body: string, ticket?: TicketRef) => {
      if (o.existing && !byBranch.has(branch)) open(branch, title, "", ticket);
      const { ref, was } = open(branch, title, body, ticket);
      const c = get(ref);
      host.mrTitle = title;
      host.mrDescription = c.body;
      host.mrOpened = !was;
      return { ref, url: c.url };
    },
    change: async (ref: ChangeRef): Promise<Change> => ({ ...get(ref), behind: behind > 0 }),
    // Only the change's current head counts. A caller that passes another sha never sees green.
    checks: async (at: { change: ChangeRef; sha: string } | { branch: string; sha: string }): Promise<Checks> => {
      if ("change" in at) return at.sha === (changes.get(at.change)?.head ?? head) ? (o.changeChecks ?? "green") : "running";
      host.mainPipelineRef = at.branch;
      return o.branchChecks ?? "green";
    },
    merge: async (ref: ChangeRef, sha: string, message: string) => {
      const c = get(ref);
      if (sha !== c.head) throw new Error(`Change ${ref} did not merge: ${sha} is not its head`);
      if (behind > 0) throw new Error(`Change ${ref} did not merge: the branch is behind`);
      Object.assign(c, { open: false, merged: true });
      host.merged = true;
      host.mergedSha = sha;
      host.mergeMessage = message;
      return c.landedSha;
    },
    rebases: 0, // rebases that worked
    rebase: async (ref: ChangeRef) => {
      const c = get(ref);
      if (o.rebaseFails) return { ok: false as const, error: "Rebase failed: conflict in src/List.tsx" };
      behind = Math.max(0, behind - 1);
      c.head = `${head}-r${++host.rebases}`;
      return { ok: true as const, head: c.head };
    },
    readFile: async (path: string) => o.files?.[path],
    branchDiff: async (sha: string) => o.diffs?.[sha] ?? DIFF,
    // The newest change whose branch starts with factory/<ticket>-, in any state.
    changeOfTicket: async (ticket: TicketRef) => {
      const c = [...changes.values()].filter((x) => x.branch.startsWith(changeBranchPrefix(ticket))).at(-1);
      return c && { ref: c.ref, open: c.open, merged: c.merged, url: c.url };
    },
    revert: async (sha: string) => {
      host.revertOpened = true;
      return { ref: `revert-${sha.slice(0, 8)}`, url: "https://host.example/changes/revert" };
    },
    commentChange: async (ref: ChangeRef, text: string) => {
      get(ref);
      if (findSecrets(text).length > 0) throw new Error("Comment refused: it contains a secret");
      host.mrComments.push(text);
      host.sayOnChange(ref, FAKE_FACTORY, text, undefined, true);
    },
    // A person (or, with byFactory, the factory) comments on the change on the host.
    sayOnChange: (ref: ChangeRef, author: PersonRef, body: string, at = new Date().toISOString(), byFactory = false) => {
      get(ref);
      changeNotes.set(ref, [{ author, byFactory, body, at }, ...(changeNotes.get(ref) ?? [])]);
      const c = get(ref);
      c.updatedAt = later(c.updatedAt, at); // a comment updates the change, as on the host
    },
    changeComments: async (ref: ChangeRef, since?: string): Promise<Comment[]> => (get(ref), (changeNotes.get(ref) ?? []).filter((c) => !since || Date.parse(c.at) > Date.parse(since))),
    changeEdits: async (ref: ChangeRef, since?: string) => (get(ref), (edits.get(ref) ?? []).filter((e) => !since || Date.parse(e.at) > Date.parse(since))),
    changeCommits: async (ref: ChangeRef) => (get(ref), commits.get(ref) ?? []),
    baseCommits: async (since: string) => baseLog.filter((c) => Date.parse(c.at) > Date.parse(since)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
    // The open changes of factory branches updated after since, newest first.
    recentChanges: async (since: string) =>
      [...changes.values()]
        .filter((c) => c.open && c.updatedAt !== undefined && Date.parse(c.updatedAt) > Date.parse(since) && ticketOfBranch(c.branch))
        .sort((a, b) => Date.parse(b.updatedAt!) - Date.parse(a.updatedAt!))
        .map((c) => ({ ref: c.ref, ticket: ticketOfBranch(c.branch)! })),
    assignChange: async (ref: ChangeRef, person: PersonRef) => void host.assigned.push({ ref, person }),
    attach: async (name: string, data: Buffer) => {
      if (++attachCalls <= (o.attachFails ?? 0)) throw new Error("GitLab POST /projects/1/uploads failed with status 500");
      attached.push({ name, size: data.length });
      return `/uploads/${attached.length}/${name}`;
    },
    closeChange: async (ref: ChangeRef) => void (get(ref).open = false),
  } satisfies CodeHost & Record<string, unknown>;
  return host;
}

export interface FakeCiOptions {
  vars?: Partial<RunVars>;
  secrets?: Record<string, string>;
  runs?: Map<string, RunRecord>; // run records by run ID, as the CI keeps them; share one map between fakes to carry a run over
}

type Start = Parameters<CiRunner["start"]>[0];
// A pipeline that start() queued: its run ID and what was asked for.
export type QueuedRun = Start & { run: string };

// An in-memory CiRunner for tests. A secret is read once, a foreign run is refused.
// start() queues a pipeline with a new run ID. save() keeps a run's record under its run ID, as the artifacts of a
// finished pipeline do, and buildRecord() serves it back as a copy: a run that saved none is refused.
export function fakeCi(o: FakeCiOptions = {}) {
  const secrets = new Map(Object.entries(o.secrets ?? {}));
  const runs = o.runs ?? new Map<string, RunRecord>();
  let lastRun = Number(o.vars?.run ?? 0);
  const copy = (r: RunRecord): RunRecord => JSON.parse(JSON.stringify(r));
  const ci = {
    vars: { skipApply: false, runUrl: "https://ci.example/runs/1", ...o.vars } as RunVars,
    started: [] as Start[],
    queue: [] as QueuedRun[],
    runs,
    finishTriggered: false,
    finishVars: {} as Partial<Start>,
    restored: [] as string[],
    secret: (name: string) => {
      const v = secrets.get(name);
      secrets.delete(name);
      return v;
    },
    start: async (run: Start) => {
      ci.started.push(run);
      ci.queue.push({ ...run, run: String(++lastRun) });
      if (run.kind === "finish") Object.assign(ci, { finishTriggered: true, finishVars: run });
      return "https://ci.example/runs/new";
    },
    save: (run: string, record: RunRecord) => void runs.set(run, copy(record)),
    buildRecord: async (run: string): Promise<RunRecord> => {
      const r = runs.get(run);
      if (!r) throw new NotFactoryRunError(`Run ${run} is not a factory build run`);
      return copy(r);
    },
    restoreRun: async (run: string) => void ci.restored.push(run),
  } satisfies CiRunner & Record<string, unknown>;
  return ci;
}

// A Chat for tests. It keeps every notice it was given.
export function fakeChat(): Chat & { sent: { kind: Notice; title: string; lines: string[]; url: string }[] } {
  const sent: { kind: Notice; title: string; lines: string[]; url: string }[] = [];
  return { sent, notify: async (kind, title, lines, url) => void sent.push({ kind, title, lines, url }) };
}

// A Dashboard for tests. It keeps every event and every finished request. While `down` is true it
// drops events and `control` and `requestDone` throw, as the real one does when it cannot be reached.
export function fakeDashboard(state: Partial<ControlState> = {}, pending: Dispatch[] = []): Dashboard & { events: RunEvent[]; done: [string, string][]; down: boolean; pending: Dispatch[]; agentPlans: AgentPlan[] } {
  const dash = {
    events: [] as RunEvent[],
    done: [] as [string, string][],
    down: false,
    pending,
    agentPlans: [] as AgentPlan[],
    plans: async () => dash.agentPlans.filter((p) => p.state === "approved"),
    // As the dashboard does: a claim works only from approved, so a second worker gets false.
    planUpdate: async (id: string, state: "running" | "done" | "failed", result?: string) => {
      const p = dash.agentPlans.find((q) => q.id === id);
      if (!p || (state === "running" ? p.state !== "approved" : p.state !== "running")) return false;
      Object.assign(p, { state, result });
      return true;
    },
    dispatches: async (target: string) => dash.pending.filter((s) => s.target === target),
    dispatchDone: async (id: string) => void (dash.pending = dash.pending.filter((s) => s.id !== id)),
    history: async (target: string, since: string, types: EventType[]) => {
      if (dash.down) throw new Error("dashboard is down");
      return dash.events.filter((e) => e.target === target && Date.parse(e.at) >= Date.parse(since) && types.includes(e.type));
    },
    send: (e: RunEvent) => void (dash.down || dash.events.push(e)),
    flush: async () => {},
    control: async () => {
      if (dash.down) throw new Error("dashboard is down");
      return { switches: defaultSwitches(), stop: false, requests: [], ...state };
    },
    requestDone: async (id: string, outcome: "done" | "refused" | "cancelled") => {
      if (dash.down) throw new Error("dashboard is down");
      dash.done.push([id, outcome]);
      // As the dashboard does: the next control read shows the outcome.
      const r = state.requests?.find((q) => q.id === id);
      // "cancelled" keeps the request pending; a later outcome does not replace it.
      if (r) Object.assign(r, outcome === "cancelled" ? { outcome } : { outcome: r.outcome === "cancelled" ? r.outcome : outcome, doneAt: new Date().toISOString() });
    },
  };
  return dash;
}

// A Judge for tests. `answer` gives the answer to one question; `asked` counts the ask calls.
export function fakeJudge(answer: (q: JevQuestion, state: unknown) => JevAnswer): Judge & { asked: number } {
  const judge = {
    provider: "mock" as const,
    asked: 0,
    ask: async (state: unknown, questions: JevQuestion[]) => {
      judge.asked++;
      return questions.map((q) => answer(q, state));
    },
  };
  return judge;
}

// A Harness for tests. `script` gives the result of job n (from 0); the rest is filled with an ok answer.
// `toolCalls` in the script's answer are given to the job's onToolCall before run resolves, when the job has one.
export function fakeHarness(script: (job: HarnessJob, n: number) => Partial<HarnessResult> & { toolCalls?: ToolCall[] } = () => ({})): Harness & { jobs: HarnessJob[] } {
  const jobs: HarnessJob[] = [];
  return {
    apis: ["anthropic", "openai"],
    home: "fake-home",
    images: true,
    jobs,
    run: async (job) => {
      const n = jobs.push(job) - 1;
      const { toolCalls = [], ...result } = script(job, n);
      toolCalls.forEach((c) => job.onToolCall?.(c));
      return { session: `fake-session-${n}`, ok: true, limitHit: false, stopped: false, costUsd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextTokens: 0, text: "", ...result };
    },
  };
}

// A LogSource for tests: it returns the groups last seen at or after `since`.
export function fakeLogs(groups: ErrorGroup[]): LogSource {
  return { errors: async (since) => groups.filter((g) => Date.parse(g.lastSeen) >= since.getTime()) };
}
