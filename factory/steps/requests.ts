// Part G: a `@factory` request from a trusted person starts a round on a ticket that waits for a person, or gets a reply.
import { cursorLine, isRequest, later, readCursor, stateReply } from "../requests";
import type { Request } from "../record";
import type { ChangeRef, Comment, FactoryState, Ticket, TicketRef } from "../seams";
import { INJECTION_LIMIT, buildTriageState, injectionQuestion } from "../triage";
import { facts, save, type StepContext, type StepResult } from "./context";
import { buildRunOf } from "./merge";
import { block, continueAt } from "./run";

// One Tracker.trusted call per author.
const trustCache = (ctx: StepContext) => {
  const seen = new Map<string, Promise<boolean>>();
  return (author: string) => seen.get(author) ?? seen.set(author, ctx.tracker.trusted(author)).get(author)!;
};

// The requests after the cursor, oldest first, from the work item and from its open change.
export async function newRequests(ctx: StepContext, ref: TicketRef): Promise<{ requests: Request[]; change?: { ref: ChangeRef; url: string } }> {
  const c = await ctx.codeHost.changeOfTicket(ref);
  const onItem = await ctx.tracker.comments(ref);
  const onChange = c ? await ctx.codeHost.changeComments(c.ref) : [];
  // No cursor line: the factory's newest comment on the change. With neither, nothing is read.
  const cursor = readCursor([...onItem, ...onChange]) ?? onChange.filter((x) => x.byFactory).reduce<string | undefined>((t, x) => later(t, x.at), undefined);
  if (cursor === undefined) return { requests: [] };
  const open = c?.open ? { ref: c.ref, url: c.url } : undefined;
  const trusted = trustCache(ctx);
  const requests: Request[] = [];
  const take = async (list: Comment[], on: Request["on"]) => {
    for (const x of list) {
      if (x.byFactory || Date.parse(x.at) <= Date.parse(cursor) || !isRequest(x.body)) continue;
      if (await trusted(x.author)) requests.push({ author: x.author, body: x.body, at: x.at, on });
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
    // ponytail: a slow queue can start the same round twice; requestRound stops the second quietly.
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

// Starting a round means a `@factory` request on a change that waits for a person; the event step runs this for the poller's build.
// ponytail: the poller starts the same round build every minute until this step sets factory_running or writes a cursor line, and
// the event job runs one at a time per target: the second build finds no needs_approval and stops quietly. Add a start marker if that is too noisy.
export async function requestRound(ctx: StepContext, ref: TicketRef, buildRun: string): Promise<StepResult> {
  const quiet = (reason: string, error?: string) => (save(ctx, "event", { start: false, reason, ticket: ref, ...(error ? { error } : {}) }), "stop" as const);
  const t = await ctx.tracker.ticket(ref);
  if (t.state !== "needs_approval") return quiet("not-waiting");
  const why = facts(ctx).cannotContinue(`${ctx.target.projectPath}#${ref}`, buildRun);
  if (why) return block(ctx, `The factory could not start a round: ${why}. Add factory_ready to start again.`);
  // Requests wait for a change that is open. A quiet stop writes nothing: there is nothing to answer.
  const { requests, change } = await newRequests(ctx, ref);
  if (!change || requests.length === 0) return quiet("no-request");
  const newest = requests.at(-1)!.at;
  const authors = [...new Set(requests.map((r) => r.author))].map((a) => `@${a}`).join(" ");
  // The change stays open and waiting, so a person can still merge it. The cursor line stops the poller from asking again.
  if (change.ref !== facts(ctx).change) {
    await ctx.tracker.comment(ref, `${authors} The factory could not start a round: the open change ${change.ref} is not the change of pipeline ${buildRun}. The change still waits for a person.\n\n${cursorLine(newest)}`);
    return quiet("change-mismatch");
  }
  // From here the ticket either starts running or gets a cursor line, so the poller does not start the same round again.
  // A judge that fails refuses nothing and writes no cursor: the next poll tries again.
  try {
    for (const r of requests) {
      const [a] = await ctx.judge.ask(buildTriageState(`Request by ${r.author}`, r.body, []), [injectionQuestion]);
      if (!a) throw new Error(`The judge gave no answer for "${injectionQuestion.id}"`);
      // Fails closed, like triage: NaN counts as an injection, and one request refuses the whole round.
      if (!(a.probability < INJECTION_LIMIT)) {
        await ctx.tracker.comment(ref, `${authors} The factory did not act on this request: the judge found it may try to give an AI agent orders. A person must read it. The change still waits for a person.\n\n${cursorLine(newest)}`);
        return quiet("injection");
      }
    }
  } catch (e) {
    console.log(`Judge failed for the requests of ticket ${ref}: ${String(e).slice(0, 300)}`);
    return quiet("judge-error", String(e).slice(0, 500));
  }
  await ctx.ci.restoreRun(buildRun);
  await ctx.tracker.comment(ref, `The factory started another round for the requests of ${authors}.\n\n${cursorLine(newest)}`);
  for (const m of ["implemented", "reviewed", "checked", "risk_checked"] as const) if (t.marks.includes(m)) await ctx.tracker.unmark(ref, m);
  const rounds = [...(ctx.record.requestRounds ?? []), { cursor: newest, requests, costAtStart: ctx.record.costUsd, tokensAtStart: ctx.record.tokens ?? { input: 0, output: 0 } }];
  ctx.record = { ...ctx.record, rounds: { review: 0, gate: 0 }, requestRounds: rounds };
  return continueAt(ctx, ref, "prepare-patch", { fromPipeline: buildRun, sessionId: facts(ctx).session, round: rounds.length });
}

export const REPLY_WINDOW_MS = 10 * 60_000;

// One reply on the change of a work item in a state that has no other path (needs_approval, running, stopped and waiting have one).
// ponytail: one listing call and at most 100 changes a minute; a request older than 10 minutes when the poller was down gets no reply. Widen REPLY_WINDOW_MS or page further if that bites.
export async function replyOnChanges(ctx: StepContext): Promise<TicketRef[]> {
  const since = new Date(Date.now() - REPLY_WINDOW_MS).toISOString();
  const trusted = trustCache(ctx);
  const replied: TicketRef[] = [];
  for (const { ref, ticket } of await ctx.codeHost.recentChanges(since)) {
    try {
      const comments = await ctx.codeHost.changeComments(ref, since);
      const cursor = readCursor(comments);
      let requests: Comment[] = [];
      for (const x of comments) if (!x.byFactory && isRequest(x.body) && (cursor === undefined || Date.parse(x.at) > Date.parse(cursor)) && (await trusted(x.author))) requests.push(x);
      if (requests.length === 0) continue;
      const t = await ctx.tracker.ticket(ticket);
      if (t.state && ["needs_approval", "running", "stopped", "waiting"].includes(t.state)) continue;
      // The webhook answers on the work item, with its own cursor line: that counts for the change too.
      const seen = later(cursor, readCursor(await ctx.tracker.comments(ticket)));
      requests = requests.filter((x) => seen === undefined || Date.parse(x.at) > Date.parse(seen));
      if (requests.length === 0) continue;
      const newest = requests.reduce<string | undefined>((a, x) => later(a, x.at), undefined)!;
      const authors = [...new Set(requests.map((x) => x.author))];
      await ctx.codeHost.commentChange(ref, [...authors.map((a) => stateReply(a, t.state)), cursorLine(newest)].join("\n\n"));
      replied.push(ticket);
    } catch (e) {
      console.log(`Reply on change ${ref} failed: ${String(e).slice(0, 300)}`);
    }
  }
  return replied;
}
