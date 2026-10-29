// The factory's outside tools, in factory words. Steps use these types and never a tool's own words.
import type { RunRecord } from "./record";

export type TicketRef = string; // opaque to steps; the GitLab adapter uses the iid as text
export type PersonRef = string; // a username
export type ChangeRef = string;
export type FactoryState = "ready" | "running" | "needs_info" | "needs_approval" | "waiting" | "stopped" | "blocked" | "done";
export type Mark = "watcher";

export interface Ticket {
  ref: TicketRef; title: string; body: string; open: boolean; state?: FactoryState; marks: Mark[];
  tags: string[]; // the non-factory labels
  assignees: PersonRef[]; url: string;
}
export interface Comment { author: PersonRef; byFactory: boolean; body: string; at: string }

export type FactoryEvent =
  | { kind: "ready"; ticket: TicketRef; actor: PersonRef }
  | { kind: "approved" | "merged"; ticket: TicketRef; change: ChangeRef; actor: PersonRef }
  | { kind: "command"; ticket: TicketRef; actor: PersonRef; command: "stop" | "resume" }
  | { kind: "ignored"; reason: "other-project" | "not-added" };

export interface TicketDraft { title: string; body: string; state?: FactoryState; marks: Mark[]; fingerprint: string }

export interface Tracker {
  ticket(ref: TicketRef): Promise<Ticket>;
  setState(ref: TicketRef, state: FactoryState): Promise<void>;
  comment(ref: TicketRef, text: string): Promise<void>;
  assign(ref: TicketRef, person: PersonRef): Promise<void>;
  close(ref: TicketRef): Promise<void>;
  reopen(ref: TicketRef): Promise<void>;
  list(state: FactoryState): Promise<Ticket[]>; // open tickets, oldest first
  listClosed(count: number): Promise<Ticket[]>;
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
}

export type Checks = "green" | "red" | "running" | "none";
export interface Change { ref: ChangeRef; open: boolean; merged: boolean; head: string; landedSha: string; url: string; body: string }
export interface CodeHost {
  defaultBranch(): Promise<string>;
  cloneAt(dir: string): Repo;
  openChange(branch: string, title: string, body: string, ticket: TicketRef): Promise<{ ref: ChangeRef; url: string }>; // adds the AI line and the closing line
  change(ref: ChangeRef): Promise<Change>;
  approvedByTrusted(ref: ChangeRef): Promise<boolean>;
  checks(at: { change: ChangeRef; sha: string } | { branch: string; sha: string }): Promise<Checks>;
  merge(ref: ChangeRef, sha: string): Promise<string>;
  revert(sha: string): Promise<{ ref: ChangeRef; url: string }>;
  commentChange(ref: ChangeRef, text: string): Promise<void>;
  assignChange(ref: ChangeRef, person: PersonRef): Promise<void>;
}

// The run is not one the factory started. Never worth a retry.
export class NotFactoryRunError extends Error {}

export type RunKind = "build" | "finish";
export interface RunVars { ticket?: TicketRef; change?: ChangeRef; skipApply: boolean; buildRun?: string; run?: string; runUrl: string; payload?: unknown }
export interface CiRunner {
  vars: RunVars;
  secret(name: string): string | undefined; // read once, then gone
  start(run: { kind: RunKind; ticket: TicketRef; change?: ChangeRef; buildRun?: string; skipApply?: boolean }): Promise<void>;
  buildRecord(run: string): Promise<RunRecord>; // throws NotFactoryRunError on a failed provenance check
  restoreRun(run: string): Promise<void>;
}

export type Notice = "needs_info" | "needs_approval" | "blocked" | "done" | "waiting" | "watcher_ticket";
export interface Chat { notify(kind: Notice, title: string, lines: string[], url: string): Promise<void> }

export type { JevClient as Judge, JevQuestion, JevAnswer } from "./jev";

// An agent harness: the program that runs a model with tools. Steps give it a job and get a result.
export type ApiStyle = "anthropic" | "openai";
export interface Provider { name: string; api: ApiStyle; baseUrl?: string; keyEnv: string; models: Record<string, string> } // model id -> family
export interface ModelChoice { provider: Provider; model: string; effort?: "medium" | "high" }
export type Role = "author" | "reviewer" | "writer";
export interface Inbox { poll(): Promise<{ comments: string[]; stop: boolean }> }
export interface HarnessJob { role: Role; prompt: string; model: ModelChoice; cwd: string; tools: "code" | "none"; resume?: string; inbox?: Inbox; maxTurns: number }
// `stopped` tells a `@factory stop` from a failure: the inbox found a stop line while the agent ran.
export interface HarnessResult { session: string; ok: boolean; limitHit: boolean; stopped: boolean; costUsd: number; tokens: { input: number; output: number }; text: string }
export interface Harness { readonly apis: ApiStyle[]; run(job: HarnessJob): Promise<HarnessResult> }
