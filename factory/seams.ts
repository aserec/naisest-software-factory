// The factory's outside tools, in factory words. Steps use these types and never a tool's own words.

export type TicketRef = string; // opaque to steps; the GitLab adapter uses the iid as text
export type PersonRef = string; // a username
export type ChangeRef = string;
export type FactoryState = "ready" | "running" | "needs_info" | "needs_approval" | "waiting" | "paused" | "blocked" | "done";
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
  | { kind: "command"; ticket: TicketRef; actor: PersonRef; command: "stop" | "continue" } // filled in Task 8
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
