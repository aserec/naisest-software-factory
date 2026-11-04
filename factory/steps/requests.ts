// Part G: a `@factory` request from a trusted person starts a round on a ticket that waits for a person, or gets a reply.
import { cursorLine, isRequest, later, readCursor, stateReply } from "../requests";
import type { Request } from "../record";
import type { ChangeRef, Comment, FactoryState, Ticket, TicketRef } from "../seams";
import type { StepContext } from "./context";
import { buildRunOf } from "./merge";

// The requests after the cursor, oldest first, from the work item and from its open change.
export async function newRequests(ctx: StepContext, ref: TicketRef): Promise<{ requests: Request[]; change?: { ref: ChangeRef; url: string } }> {
  const c = await ctx.codeHost.changeOfTicket(ref);
  const onItem = await ctx.tracker.comments(ref);
  const onChange = c ? await ctx.codeHost.changeComments(c.ref) : [];
  // No cursor line: the factory's newest comment on the change. With neither, nothing is read.
  const cursor = readCursor([...onItem, ...onChange]) ?? onChange.filter((x) => x.byFactory).reduce<string | undefined>((t, x) => later(t, x.at), undefined);
  if (cursor === undefined) return { requests: [] };
  const open = c?.open ? { ref: c.ref, url: c.url } : undefined;
  const trust = new Map<string, Promise<boolean>>();
  const requests: Request[] = [];
  const take = async (list: Comment[], on: Request["on"]) => {
    for (const x of list) {
      if (x.byFactory || Date.parse(x.at) <= Date.parse(cursor) || !isRequest(x.body)) continue;
      if (await (trust.get(x.author) ?? trust.set(x.author, ctx.tracker.trusted(x.author)).get(x.author)!)) requests.push({ author: x.author, body: x.body, at: x.at, on });
    }
  };
  await take(onItem, "work item");
  if (open) await take(onChange, "change");
  return { requests: requests.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)), ...(open ? { change: open } : {}) };
}

// needs_approval: start a round. running: nothing, the inbox has it. Any other state: one reply on the work item.
export async function answerRequests(ctx: StepContext, t: Ticket): Promise<"started" | "replied" | "none"> {
  if (t.state === "running") return "none";
  const { requests, change } = await newRequests(ctx, t.ref);
  if (requests.length === 0) return "none";
  if (t.state === "needs_approval") {
    const buildRun = change && buildRunOf((await ctx.codeHost.change(change.ref)).body);
    if (!buildRun) throw new Error(`Ticket ${t.ref} waits for a person, but its change has no build run`);
    // ponytail: a slow queue can start the same round twice; the event step (Task 5) stops the second quietly.
    await ctx.ci.start({ kind: "build", ticket: t.ref, buildRun });
    return "started";
  }
  const authors = [...new Set(requests.map((r) => r.author))];
  await ctx.tracker.comment(t.ref, [...authors.map((a) => stateReply(a, t.state)), cursorLine(requests.at(-1)!.at)].join("\n\n"));
  return "replied";
}

// At most one round per tick, for the oldest ticket that waits for a person; then replies for stopped and waiting tickets.
// `skip`: tickets this poll started already.
export async function pollRequests(ctx: StepContext, skip: TicketRef[] = []): Promise<TicketRef[]> {
  const started: TicketRef[] = [];
  for (const state of ["needs_approval", "stopped", "waiting"] as FactoryState[]) {
    for (const t of await ctx.tracker.list(state)) {
      if (skip.includes(t.ref) || (state === "needs_approval" && started.length > 0)) continue;
      // One failed ticket must not stop the poller: it is logged and tried again next minute.
      try {
        if ((await answerRequests(ctx, t)) === "started") started.push(t.ref);
      } catch (e) {
        console.log(`Request of ticket ${t.ref} failed: ${String(e).slice(0, 300)}`);
      }
    }
  }
  return started;
}
