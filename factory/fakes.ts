import { AI_LINE, noQuickActions } from "./gitlab";
import type { RunRecord } from "./record";
import { findSecrets } from "./rules";
import { NotFactoryRunError } from "./seams";
import type { Change, ChangeRef, Checks, Chat, CiRunner, CodeHost, Comment, FactoryEvent, FactoryState, Harness, HarnessJob, HarnessResult, Judge, JevAnswer, JevQuestion, LogSource, ErrorGroup, Mark, Notice, PersonRef, Repo, RunVars, Ticket, TicketDraft, TicketRef, Tracker } from "./seams";

export const FAKE_FACTORY: PersonRef = "factory-bot";

// An in-memory Tracker for tests. It keeps the rules of the real one: secrets are refused, the factory is not trusted.
export function fakeTracker(seed: Partial<Ticket>[] = []): Tracker & { tickets: Map<TicketRef, Ticket>; posted: { ref: TicketRef; text: string }[]; created: TicketDraft[]; say(ref: TicketRef, author: PersonRef, body: string, at?: string): void } {
  const tickets = new Map<TicketRef, Ticket>();
  const notes = new Map<TicketRef, Comment[]>();
  const fingerprints = new Map<TicketRef, string>();
  const posted: { ref: TicketRef; text: string }[] = [];
  const created: TicketDraft[] = [];
  const add = (t: Partial<Ticket>): Ticket => {
    const ref = t.ref ?? String(tickets.size + 1);
    const ticket: Ticket = { title: "", body: "", open: true, marks: [], tags: [], assignees: [], url: `https://tracker.example/${ref}`, ...t, ref };
    tickets.set(ref, ticket);
    return ticket;
  };
  seed.forEach(add);
  const get = (ref: TicketRef) => {
    const t = tickets.get(ref);
    if (!t) throw new Error(`No ticket ${ref}`);
    return t;
  };

  return {
    tickets, posted, created,
    // A comment from a person, for inbox tests.
    say: (ref, author, body, at = new Date().toISOString()) => void notes.set(ref, [{ author, byFactory: false, body, at }, ...(notes.get(ref) ?? [])]),
    ticket: async (ref) => get(ref),
    setState: async (ref, state: FactoryState) => { get(ref).state = state; },
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
  };
}

export interface FakeCodeHostOptions {
  defaultBranch?: string;
  head?: string; // the commit of the change; only this one is ever green or mergeable
  landedSha?: string; // what merge returns
  existing?: boolean; // a change of the branch is already open
  merged?: boolean; // the change is already merged, by a person
  approvedByTrusted?: boolean;
  changeChecks?: Checks; // checks of the head
  branchChecks?: Checks;
  repo?: Repo;
}

// An in-memory CodeHost for tests. It keeps the rules of the real one: the AI line and the closing line,
// no line that starts with "/", secrets refused, merge only of the head.
export function fakeCodeHost(o: FakeCodeHostOptions = {}) {
  const head = o.head ?? "head1";
  const changes = new Map<ChangeRef, Change & { branch: string; title: string }>();
  const byBranch = new Map<string, ChangeRef>();
  const open = (branch: string, title: string, body: string, ticket: TicketRef) => {
    const text = noQuickActions([AI_LINE, `Closes #${ticket}`, body].join("\n\n"));
    const ref = byBranch.get(branch) ?? String(changes.size + 5);
    byBranch.set(branch, ref);
    const was = changes.get(ref);
    changes.set(ref, { ref, branch, title, body: text, open: !o.merged, merged: !!o.merged, head, landedSha: o.landedSha ?? "landed1", url: `https://host.example/changes/${ref}` });
    return { ref, was: !!was };
  };
  const get = (ref: ChangeRef) => {
    const c = changes.get(ref);
    if (!c) throw new Error(`No change ${ref}`);
    return c;
  };
  const host = {
    mrComments: [] as string[],
    mrTitle: "",
    mrDescription: "",
    mrOpened: false,
    merged: false,
    mergedSha: "",
    revertOpened: false,
    mainPipelineRef: "",
    assigned: [] as { ref: ChangeRef; person: PersonRef }[],
    defaultBranch: async () => o.defaultBranch ?? "main",
    cloneAt: () => {
      if (!o.repo) throw new Error("This fake code host has no repo");
      return o.repo;
    },
    openChange: async (branch: string, title: string, body: string, ticket: TicketRef) => {
      if (o.existing && !byBranch.has(branch)) open(branch, title, "", ticket);
      const { ref, was } = open(branch, title, body, ticket);
      const c = get(ref);
      host.mrTitle = title;
      host.mrDescription = c.body;
      host.mrOpened = !was;
      return { ref, url: c.url };
    },
    change: async (ref: ChangeRef): Promise<Change> => get(ref),
    approvedByTrusted: async () => o.approvedByTrusted ?? false,
    // Only the reviewed head counts. A caller that passes another sha never sees green.
    checks: async (at: { change: ChangeRef; sha: string } | { branch: string; sha: string }): Promise<Checks> => {
      if ("change" in at) return at.sha === head ? (o.changeChecks ?? "green") : "running";
      host.mainPipelineRef = at.branch;
      return o.branchChecks ?? "green";
    },
    merge: async (ref: ChangeRef, sha: string) => {
      const c = get(ref);
      if (sha !== c.head) throw new Error(`Change ${ref} did not merge: ${sha} is not its head`);
      Object.assign(c, { open: false, merged: true });
      host.merged = true;
      host.mergedSha = sha;
      return c.landedSha;
    },
    revert: async (sha: string) => {
      host.revertOpened = true;
      return { ref: `revert-${sha.slice(0, 8)}`, url: "https://host.example/changes/revert" };
    },
    commentChange: async (ref: ChangeRef, text: string) => {
      get(ref);
      if (findSecrets(text).length > 0) throw new Error("Comment refused: it contains a secret");
      host.mrComments.push(text);
    },
    assignChange: async (ref: ChangeRef, person: PersonRef) => void host.assigned.push({ ref, person }),
  } satisfies CodeHost & Record<string, unknown>;
  return host;
}

export interface FakeCiOptions {
  vars?: Partial<RunVars>;
  secrets?: Record<string, string>;
  records?: Record<string, RunRecord>; // runs the factory started; any other run is refused
}

type Start = Parameters<CiRunner["start"]>[0];

// An in-memory CiRunner for tests. A secret is read once, a foreign run is refused.
export function fakeCi(o: FakeCiOptions = {}) {
  const secrets = new Map(Object.entries(o.secrets ?? {}));
  const ci = {
    vars: { skipApply: false, runUrl: "https://ci.example/runs/1", ...o.vars } as RunVars,
    started: [] as Start[],
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
      if (run.kind === "finish") Object.assign(ci, { finishTriggered: true, finishVars: run });
    },
    buildRecord: async (run: string): Promise<RunRecord> => {
      const r = o.records?.[run];
      if (!r) throw new NotFactoryRunError(`Run ${run} is not a factory build run`);
      return r;
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
export function fakeHarness(script: (job: HarnessJob, n: number) => Partial<HarnessResult> = () => ({})): Harness & { jobs: HarnessJob[] } {
  const jobs: HarnessJob[] = [];
  return {
    apis: ["anthropic", "openai"],
    images: true,
    jobs,
    run: async (job) => {
      const n = jobs.push(job) - 1;
      return { session: `fake-session-${n}`, ok: true, limitHit: false, stopped: false, costUsd: 0, tokens: { input: 0, output: 0 }, text: "", ...script(job, n) };
    },
  };
}

// A LogSource for tests: it returns the groups last seen at or after `since`.
export function fakeLogs(groups: ErrorGroup[]): LogSource {
  return { errors: async (since) => groups.filter((g) => Date.parse(g.lastSeen) >= since.getTime()) };
}
