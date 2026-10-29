import { findSecrets } from "./rules";
import type { Comment, FactoryEvent, FactoryState, Mark, PersonRef, Ticket, TicketDraft, TicketRef, Tracker } from "./seams";

export const FAKE_FACTORY: PersonRef = "factory-bot";

// An in-memory Tracker for tests. It keeps the rules of the real one: secrets are refused, the factory is not trusted.
export function fakeTracker(seed: Partial<Ticket>[] = []): Tracker & { tickets: Map<TicketRef, Ticket>; posted: { ref: TicketRef; text: string }[]; created: TicketDraft[] } {
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
    ticket: async (ref) => get(ref),
    setState: async (ref, state: FactoryState) => { get(ref).state = state; },
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
