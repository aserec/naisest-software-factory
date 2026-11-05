// Part G: a `@factory` request from a trusted person starts a round on a ticket that waits for a person, or gets a reply.
import { conversation, later, refusal, stateReply } from "../conversation";
import type { ChangeRef, FactoryState, Ticket, TicketRef } from "../seams";
import { facts, save, type StepContext, type StepResult } from "./context";
import { buildRunOf } from "./merge";
import { block, continueAt } from "./run";

// needs_approval: start a round. blocked, needs_info: ready again, as if the newest author added factory_ready.
// running: nothing, the inbox has it. Any other state: one reply on the work item.
export async function answerRequests(ctx: StepContext, t: Ticket): Promise<"started" | "replied" | "none"> {
  if (t.state === "running") return "none";
  const conv = conversation(ctx);
  const { requests, change } = await conv.requests(t.ref, t.state !== "needs_approval");
  if (requests.length === 0) return "none";
  if (t.state === "needs_approval") {
    const buildRun = change && buildRunOf((await ctx.codeHost.change(change.ref)).body);
    if (!buildRun) throw new Error(`Ticket ${t.ref} waits for a person, but its change has no build run`);
    // ponytail: a slow queue can start the same round twice; requestRound stops the second quietly.
    // The change marks this build as a round build: event.ts sends it to requestRound, never to resume.
    await ctx.ci.start({ kind: "build", ticket: t.ref, buildRun, change: change.ref });
    return "started";
  }
  if (t.state === "blocked" || t.state === "needs_info") {
    // The poller starts the ready ticket; readyActor takes the factory's ready as this person's.
    const last = requests.at(-1)!;
    // Like a round: one flagged request refuses all, with the cursor line so the next poll does not ask the judge again.
    // A judge that fails throws: pollRequests logs it and the next poll tries again.
    for (const r of requests) {
      if (await conv.isInjection(r)) {
        await conv.write(t.ref, refusal(requests.map((x) => x.author), last.at));
        return "replied";
      }
    }
    await conv.write(t.ref, { kind: "readyFor", text: `The factory starts again for the request of @${last.author}.`, person: last.author, cursor: last.at });
    await ctx.tracker.setState(t.ref, "ready");
    return "started";
  }
  const authors = [...new Set(requests.map((r) => r.author))];
  await conv.write(t.ref, { kind: "cursor", text: authors.map((a) => stateReply(a, t.state)).join("\n\n"), at: requests.at(-1)!.at });
  return "replied";
}

// At most one round per tick, for the oldest ticket that waits for a person; then replies for stopped and waiting tickets.
// `skip`: tickets this poll started already.
export async function pollRequests(ctx: StepContext, skip: TicketRef[] = []): Promise<TicketRef[]> {
  const started: TicketRef[] = [];
  for (const state of ["needs_approval", "stopped", "waiting", "blocked", "needs_info"] as FactoryState[]) {
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
export async function requestRound(ctx: StepContext, ref: TicketRef, buildRun: string, changeRef: ChangeRef): Promise<StepResult> {
  const quiet = (reason: string, error?: string) => (save(ctx, "event", { start: false, reason, ticket: ref, ...(error ? { error } : {}) }), "stop" as const);
  const t = await ctx.tracker.ticket(ref);
  if (t.state !== "needs_approval") return quiet("not-waiting");
  // A late duplicate: a round already ran and its change names a newer build run.
  if (buildRunOf((await ctx.codeHost.change(changeRef)).body) !== buildRun) return quiet("stale-build");
  const why = facts(ctx).cannotContinue(`${ctx.target.projectPath}#${ref}`, buildRun);
  if (why) return block(ctx, `The factory could not start a round: ${why}. Add factory_ready to start again.`);
  // Requests wait for a change that is open. A quiet stop writes nothing: there is nothing to answer.
  const conv = conversation(ctx);
  const { requests, change } = await conv.requests(ref);
  if (!change || requests.length === 0) return quiet("no-request");
  const newest = requests.at(-1)!.at;
  const authors = [...new Set(requests.map((r) => r.author))].map((a) => `@${a}`).join(" ");
  // The change stays open and waiting, so a person can still merge it. The cursor line stops the poller from asking again.
  if (change.ref !== facts(ctx).change) {
    await conv.write(ref, { kind: "cursor", text: `${authors} The factory could not start a round: the open change ${change.ref} is not the change of pipeline ${buildRun}. The change still waits for a person.`, at: newest });
    return quiet("change-mismatch");
  }
  // From here the ticket either starts running or gets a cursor line, so the poller does not start the same round again.
  // A judge that fails refuses nothing and writes no cursor: the next poll tries again.
  try {
    for (const r of requests) {
      // One request that looks like an injection refuses the whole round.
      if (await conv.isInjection(r)) {
        await conv.write(ref, refusal(requests.map((r) => r.author), newest, " The change still waits for a person."));
        return quiet("injection");
      }
    }
  } catch (e) {
    console.log(`Judge failed for the requests of ticket ${ref}: ${String(e).slice(0, 300)}`);
    return quiet("judge-error", String(e).slice(0, 500));
  }
  await ctx.ci.restoreRun(buildRun);
  await conv.write(ref, { kind: "cursor", text: `The factory started another round for the requests of ${authors}.`, at: newest });
  for (const m of ["implemented", "reviewed", "checked", "risk_checked"] as const) if (t.marks.includes(m)) await ctx.tracker.unmark(ref, m);
  const rounds = [...(ctx.record.requestRounds ?? []), { cursor: newest, requests, costAtStart: ctx.record.costUsd, tokensAtStart: ctx.record.tokens ?? { input: 0, output: 0 } }];
  ctx.record = { ...ctx.record, rounds: { review: 0, gate: 0 }, requestRounds: rounds };
  return continueAt(ctx, ref, "prepare-patch", { fromPipeline: buildRun, sessionId: facts(ctx).session, round: rounds.length });
}

export const REPLY_WINDOW_MS = 10 * 60_000;

// One reply on the change of a work item in a state that has no other path (pollRequests answers the states it lists, the inbox running).
// ponytail: one listing call and at most 100 changes a minute; a request older than 10 minutes when the poller was down gets no reply. Widen REPLY_WINDOW_MS or page further if that bites.
// `skip`: tickets pollRequests answered in this poll. A ticket it set ready must not also get the ready reply.
export async function replyOnChanges(ctx: StepContext, skip: TicketRef[] = []): Promise<TicketRef[]> {
  const since = new Date(Date.now() - REPLY_WINDOW_MS).toISOString();
  const conv = conversation(ctx);
  const replied: TicketRef[] = [];
  for (const { ref, ticket } of await ctx.codeHost.recentChanges(since)) {
    if (skip.includes(ticket)) continue;
    try {
      const requests = await conv.unanswered(ref, ticket, since);
      if (requests.length === 0) continue;
      const t = await ctx.tracker.ticket(ticket);
      if (t.state && ["needs_approval", "running", "stopped", "waiting", "blocked", "needs_info"].includes(t.state)) continue;
      const newest = requests.reduce<string | undefined>((a, x) => later(a, x.at), undefined)!;
      const authors = [...new Set(requests.map((x) => x.author))];
      await conv.writeOnChange(ref, { kind: "cursor", text: authors.map((a) => stateReply(a, t.state)).join("\n\n"), at: newest });
      replied.push(ticket);
    } catch (e) {
      console.log(`Reply on change ${ref} failed: ${String(e).slice(0, 300)}`);
    }
  }
  return replied;
}
