// The factory's outside tools, in factory words. Steps use these types and never a tool's own words.
import type { RunRecord } from "./record";
import type { ControlState, EventType, RunEvent, Dispatch } from "./run-events";

export type TicketRef = string; // opaque to steps; the GitLab adapter uses the iid as text
export type PersonRef = string; // a username
export type ChangeRef = string;
export type FactoryState = "ready" | "running" | "needs_info" | "needs_approval" | "waiting" | "stopped" | "blocked" | "done";
// Progress marks: labels next to the state. A new run removes all but watcher.
export type Mark = "watcher" | "triaged" | "risk_trivial" | "risk_low" | "risk_medium" | "risk_high" | "implemented" | "reviewed" | "checked" | "risk_checked" | "merged" | "reverted";

export interface Ticket {
  ref: TicketRef; title: string; body: string; open: boolean; state?: FactoryState; marks: Mark[];
  ended?: FactoryState; // with state ready: the state of the ended run that a person set ready again
  tags: string[]; // the non-factory labels
  assignees: PersonRef[]; url: string;
}
export interface Comment { author: PersonRef; byFactory: boolean; body: string; at: string }

export type FactoryEvent =
  | { kind: "ready"; ticket: TicketRef; actor: PersonRef }
  | { kind: "merged"; ticket: TicketRef; change: ChangeRef; actor: PersonRef }
  | { kind: "command"; ticket: TicketRef; actor: PersonRef; command: "stop" | "resume" }
  | { kind: "request"; ticket: TicketRef; actor: PersonRef; change?: ChangeRef }
  | { kind: "ignored"; reason: "other-project" | "not-added" };

export interface TicketDraft { title: string; body: string; state?: FactoryState; marks: Mark[]; fingerprint: string }

export interface Tracker {
  ticket(ref: TicketRef): Promise<Ticket>;
  setState(ref: TicketRef, state: FactoryState): Promise<void>;
  clearState(ref: TicketRef): Promise<void>; // removes the state and keeps every mark
  mark(ref: TicketRef, mark: Mark): Promise<void>; // adds the mark and keeps every other one
  unmark(ref: TicketRef, mark: Mark): Promise<void>; // removes the mark and keeps every other one
  comment(ref: TicketRef, text: string): Promise<void>;
  assign(ref: TicketRef, person: PersonRef): Promise<void>;
  close(ref: TicketRef): Promise<void>;
  reopen(ref: TicketRef): Promise<void>;
  list(state: FactoryState): Promise<Ticket[]>; // open tickets, oldest first
  listClosed(count: number): Promise<Ticket[]>;
  listOpen(limit: number): Promise<Ticket[]>; // every open work item, newest first; the state is not read on a board
  trusted(actor: PersonRef): Promise<boolean>; // may command the factory; false for the factory itself
  isFactory(actor: PersonRef): Promise<boolean>;
  startedBy(ref: TicketRef): Promise<PersonRef | undefined>;
  comments(ref: TicketRef, since?: string): Promise<Comment[]>; // newest first
  parseEvent(payload: unknown): FactoryEvent;
  create(draft: TicketDraft): Promise<{ ref: TicketRef; url: string }>;
  findOpen(fingerprint: string): Promise<TicketRef | undefined>;
  createdSince(mark: Mark, since: Date): Promise<number>;
}

// The target clone. Only step code touches the code host; agents work here with no tokens.
export interface Repo {
  clone(ref: string): Promise<void>;
  // All changes in the clone against the base commit, new files included.
  diff(): Promise<{ text: string; numstat: string }>;
  // A .factory.yml command, inside the sandbox.
  run(cmd: string): Promise<{ ok: boolean; output: string }>;
  // Commits the clone's files on top of the base and force-pushes the branch. Returns the new sha.
  commitAndPush(branch: string, message: string): Promise<string>;
  readFile(path: string): string | undefined;
  // A file at the base commit the clone started from, never the work tree the agent edits. Undefined when the path is not there.
  readBase(path: string): Promise<string | undefined>;
  // A small plain file inside the clone, as bytes. Undefined, never a throw, for a missing file, a link, a path that leaves the clone, or a file over maxBytes.
  readBytes(path: string, maxBytes: number): Buffer | undefined;
}

export type Checks = "green" | "red" | "running" | "none";
export interface Change { ref: ChangeRef; open: boolean; merged: boolean; head: string; landedSha: string; url: string; title: string; body: string; target: string; behind: boolean } // behind: the target branch has commits the change lacks
export interface CodeHost {
  baseBranch(): Promise<string>;
  cloneAt(dir: string): Repo;
  openChange(branch: string, title: string, body: string, ticket?: TicketRef): Promise<{ ref: ChangeRef; url: string }>; // adds the AI line and, with a ticket, the closing line
  change(ref: ChangeRef): Promise<Change>;
  checks(at: { change: ChangeRef; sha: string } | { branch: string; sha: string }): Promise<Checks>;
  merge(ref: ChangeRef, sha: string, message: string): Promise<string>;
  rebase(ref: ChangeRef): Promise<{ ok: true; head: string } | { ok: false; error: string }>; // onto the base branch; returns when the rebase ends
  readFile(path: string): Promise<string | undefined>; // a file at the head of the base branch, through the host API; undefined when it does not exist
  branchDiff(sha: string): Promise<Record<string, string>>; // each file's diff of sha against the base branch, from their merge base; throws on a cut-off diff
  changeOfTicket(ticket: TicketRef): Promise<{ ref: ChangeRef; open: boolean; merged: boolean; url: string } | undefined>; // the newest change, in any state, whose branch starts with changeBranchPrefix(ticket)
  revert(sha: string): Promise<{ ref: ChangeRef; url: string }>;
  commentChange(ref: ChangeRef, text: string): Promise<void>;
  changeComments(ref: ChangeRef, since?: string): Promise<Comment[]>; // people's and the factory's comments, newest first, only those created after since; system notes left out
  changeEdits(ref: ChangeRef): Promise<{ author: PersonRef; byFactory: boolean; field: "title" | "body"; at: string }[]>; // edits of the title and the text, newest first; byFactory: made by the token's own user
  changeCommits(ref: ChangeRef): Promise<{ sha: string; byFactory: boolean }[]>; // byFactory: the commit's author email is FACTORY_GIT_EMAIL
  baseCommits(since: string): Promise<{ sha: string; title: string; message: string; at: string }[]>; // the commits on the base branch since, newest first, at most 100
  recentChanges(since: string): Promise<{ ref: ChangeRef; ticket: TicketRef }[]>; // the open changes of this repo from branches factory/<n>-, updated after since, newest first, at most 100, from one listing call; forks left out
  assignChange(ref: ChangeRef, person: PersonRef): Promise<void>;
  attach(name: string, data: Buffer): Promise<string>; // uploads a PNG; returns a link the change text can use in Markdown
  closeChange(ref: ChangeRef): Promise<void>; // closes without merging
}

// The factory's change branches are named factory/<ticket>-<slug>. The dash keeps ticket 12 apart from ticket 123.
export const changeBranchPrefix = (ticket: TicketRef) => `factory/${ticket}-`;
export const ticketOfBranch = (branch: string): TicketRef | undefined => /^factory\/(\d+)-/.exec(branch)?.[1];

// The run is not one the factory started. Never worth a retry.
export class NotFactoryRunError extends Error {}

export type RunKind = "build" | "finish";
export interface RunVars { ticket?: TicketRef; change?: ChangeRef; skipApply: boolean; buildRun?: string; run?: string; job?: string; runUrl: string; payload?: unknown }
export interface CiRunner {
  vars: RunVars;
  secret(name: string): string | undefined; // read once, then gone
  start(run: { kind: RunKind; ticket: TicketRef; change?: ChangeRef; buildRun?: string; skipApply?: boolean }): Promise<string>; // the new run's web URL
  buildRecord(run: string): Promise<RunRecord>; // throws NotFactoryRunError on a failed provenance check
  restoreRun(run: string): Promise<void>;
}

export type Notice = "needs_info" | "needs_approval" | "blocked" | "done" | "waiting" | "watcher_ticket";
export interface Chat { notify(kind: Notice, title: string, lines: string[], url: string): Promise<void> }

export type { JevClient as Judge, JevQuestion, JevAnswer } from "./jev";

// An agent harness: the program that runs a model with tools. Steps give it a job and get a result.
export type ApiStyle = "anthropic" | "openai";
export interface Price { input: number; output: number; cacheRead?: number; cacheWrite?: number } // USD per million tokens
export interface Provider { name: string; api: ApiStyle; baseUrl?: string; keyEnv: string; models: Record<string, string>; images?: string[]; prices?: Record<string, Price> } // models: model id -> family; images: model ids that read images
export interface ModelChoice { provider: Provider; model: string; effort?: "medium" | "high" }
export type Role = "author" | "reviewer" | "writer";
// `until` is how far a poll read (the time of its newest comment), when it read any. `heard` is told how far the agent got:
// the pump calls it when the agent has consumed a poll's news.
export interface Inbox { poll(): Promise<{ comments: string[]; stop: boolean; until?: string }>; heard?(until: string): void }
// One tool the agent used. input and result are text (JSON for input); ms is how long the tool ran.
export interface ToolCall { name: string; input: string; result: string; ms: number; ok: boolean }
export interface HarnessJob { role: Role; prompt: string; model: ModelChoice; cwd: string; tools: "code" | "none"; resume?: string; inbox?: Inbox; maxTurns: number; images?: { name: string; data: Buffer }[]; preview?: boolean; onToolCall?: (c: ToolCall) => void } // images: PNGs for the reviewer, in the order the prompt lists them; preview: the author may start the target's preview server on localhost; onToolCall is called as each tool finishes, while the agent runs
// `stopped` tells a `@factory stop` from a failure: the inbox found a stop line while the agent ran.
export interface HarnessResult { session: string; ok: boolean; limitHit: boolean; stopped: boolean; costUsd: number; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }; contextTokens: number; text: string } // contextTokens: input plus cache tokens of the last model turn
export interface Harness { readonly apis: ApiStyle[]; readonly images: boolean; run(job: HarnessJob): Promise<HarnessResult> }

// Error logs. One group is one kind of error; hourly[0] is the last hour, 24 entries.
export interface ErrorGroup { fingerprint: string; message: string; component?: string; hourly: number[]; firstSeen: string; lastSeen: string; samples: string[]; stack?: string; link: string }
export interface LogSource { errors(since: Date): Promise<ErrorGroup[]> }

// The factory's run dashboard. The factory sends events and reads the switches and requests a person set there.
export type { RunEvent, ControlState, Dispatch, SwitchName } from "./run-events";
export interface Dashboard {
  send(e: RunEvent): void; // never throws, never waits
  flush(): Promise<void>; // at most 5 s
  control(target: string, run?: string): Promise<ControlState>; // throws when the dashboard cannot be reached
  requestDone(id: string, outcome: "done" | "refused"): Promise<void>;
  dispatches(target: string): Promise<Dispatch[]>; // pending dispatches from outside systems, oldest first
  dispatchDone(id: string): Promise<void>;
  history(target: string, since: string, types: EventType[]): Promise<RunEvent[]>; // past events of the target at or after `since`, oldest first, at most 5000; throws when the dashboard cannot be reached or answers with an error
}
