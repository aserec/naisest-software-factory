import { afterEach, expect, test, vi } from "vitest";
import { main } from "./poll";
import { cursorLine } from "../requests";
import { fakeWorld, BOT } from "./test-helpers";
import { pollRequests, replyOnChanges, REPLY_WINDOW_MS } from "./requests";
import { askPerson } from "./decision";
import { addStep } from "../record";
import type { FactoryState } from "../seams";

const T0 = "2026-10-01T10:00:00Z";
const T1 = "2026-10-01T11:00:00Z";
const T2 = "2026-10-01T12:00:00Z";
const ASK = "@factory add a screenshot";
const BUILD = { kind: "build", ticket: "8", buildRun: "41" };

// Ticket 8 and its open change 5 (build run 41); the factory read up to T0.
function world(o: { state?: FactoryState; cursor?: boolean; actorLevel?: number } = {}) {
  const w = fakeWorld({ state: o.state ?? "needs_approval", actorLevel: o.actorLevel });
  w.openChange();
  if (o.cursor !== false) w.host.sayOnChange("5", BOT, `The factory waits.\n\n${cursorLine(T0)}`, T0, true);
  return w;
}

test("a trusted request on the change after the cursor starts one round with the build run", async () => {
  const w = world();
  w.host.sayOnChange("5", "dev", ASK, T1);
  expect(await pollRequests(w.ctx)).toEqual(["8"]);
  expect(w.ci.started).toEqual([BUILD]);
});
test("a trusted request on the work item starts one round too", async () => {
  const w = world();
  w.tracker.say("8", "dev", ASK, T1);
  expect(await pollRequests(w.ctx)).toEqual(["8"]);
  expect(w.ci.started).toEqual([BUILD]);
});

// Review Focus 1: only trusted people; the factory's own comments never count.
test.each([
  ["a request before the cursor", (w: ReturnType<typeof world>) => w.host.sayOnChange("5", "dev", ASK, "2026-10-01T09:00:00Z")],
  ["a comment that is no request", (w: ReturnType<typeof world>) => w.host.sayOnChange("5", "dev", "looks good", T1)],
  ["a factory comment that quotes @factory", (w: ReturnType<typeof world>) => w.host.sayOnChange("5", BOT, `You wrote: ${ASK}`, T1, true)],
])("%s starts nothing and posts nothing", async (_n, say) => {
  const w = world();
  w.tracker.trusted = async () => true; // even a tracker that trusted the factory would not make its comment a request
  say(w);
  expect(await pollRequests(w.ctx)).toEqual([]);
  expect(w.ci.started).toEqual([]);
  expect(w.workItemComments).toEqual([]);
});
test("an untrusted person's request starts nothing and posts nothing", async () => {
  const w = world({ actorLevel: 10 });
  w.host.sayOnChange("5", "stranger", ASK, T1);
  expect(await pollRequests(w.ctx)).toEqual([]);
  expect(w.ci.started).toEqual([]);
  expect(w.workItemComments).toEqual([]);
});

// Review Focus 2: only an open change of this work item.
test.each([["close", "needs_approval"], ["mergeByPerson", "needs_approval"], ["close", "stopped"], ["mergeByPerson", "stopped"]] as const)("a request on a change after %s (%s) does nothing", async (how, state) => {
  const w = world({ state });
  w.host.sayOnChange("5", "dev", ASK, T1);
  w.host[how]("5");
  expect(await pollRequests(w.ctx)).toEqual([]);
  expect(w.ci.started).toEqual([]);
  expect(w.workItemComments).toEqual([]);
});
test("a request on another work item's change does not count for ticket 8", async () => {
  const w = world();
  w.host.openChange("factory/9-other", "Other", "Factory run 42: https://ci.example/runs/42", "9");
  w.host.sayOnChange("6", "dev", ASK, T1);
  expect(await pollRequests(w.ctx)).toEqual([]);
  expect(w.ci.started).toEqual([]);
});

test("two tickets that wait for a person: one poll starts only the older one", async () => {
  const w = world();
  w.tracker.tickets.get("9")!.state = "needs_approval";
  w.host.openChange("factory/9-other", "Other", "Factory run 42: https://ci.example/runs/42", "9");
  w.host.sayOnChange("6", BOT, cursorLine(T0), T0, true);
  w.host.sayOnChange("5", "dev", ASK, T1);
  w.host.sayOnChange("6", "dev", ASK, T1);
  expect(await pollRequests(w.ctx)).toEqual(["8"]);
  expect(w.ci.started).toEqual([BUILD]);
});

test("a stopped ticket gets one reply with the cursor line, and the next poll posts nothing", async () => {
  const w = world({ state: "stopped" });
  w.host.sayOnChange("5", "dev", ASK, T1);
  w.tracker.say("8", "dev", ASK, T2);
  expect(await pollRequests(w.ctx)).toEqual([]);
  expect(w.workItemComments).toHaveLength(1);
  expect(w.workItemComments[0]).toContain("@factory resume");
  expect(w.workItemComments[0]).toContain(cursorLine(T2));
  expect(w.ci.started).toEqual([]);
  await pollRequests(w.ctx);
  expect(w.workItemComments).toHaveLength(1);
});
test("a waiting ticket gets the waiting reply", async () => {
  const w = world({ state: "waiting" });
  w.host.sayOnChange("5", "dev", ASK, T1);
  await pollRequests(w.ctx);
  expect(w.workItemComments).toHaveLength(1);
  expect(w.workItemComments[0]).toContain("usage limit");
});
test("a running ticket with a request gets nothing", async () => {
  const w = world({ state: "running" });
  w.host.sayOnChange("5", "dev", ASK, T1);
  expect(await pollRequests(w.ctx)).toEqual([]);
  expect(w.ci.started).toEqual([]);
  expect(w.workItemComments).toEqual([]);
});

test("with no cursor line, the cursor is the factory's newest comment on the change", async () => {
  const w = world({ cursor: false });
  w.host.sayOnChange("5", BOT, "Merge request opened.", T0, true);
  w.host.sayOnChange("5", "dev", ASK, "2026-10-01T09:00:00Z");
  expect(await pollRequests(w.ctx)).toEqual([]);
  w.host.sayOnChange("5", "dev", ASK, T1);
  expect(await pollRequests(w.ctx)).toEqual(["8"]);
});
test("with no cursor line and no factory comment, nothing is read", async () => {
  const w = world({ cursor: false });
  w.host.sayOnChange("5", "dev", ASK, T1);
  expect(await pollRequests(w.ctx)).toEqual([]);
  expect(w.ci.started).toEqual([]);
});
test("one ticket that fails does not stop the next", async () => {
  const w = world();
  w.tracker.tickets.get("9")!.state = "stopped";
  w.host.sayOnChange("5", "dev", ASK, T1);
  await w.tracker.comment("9", cursorLine(T0));
  w.tracker.say("9", "dev", ASK, T1);
  w.ci.start = async () => { throw new Error("status 503"); };
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await pollRequests(w.ctx);
    expect(w.workItemComments).toHaveLength(2); // the cursor line and the reply; ticket 9 stopped: answered although 8 threw
    expect(log).toHaveBeenCalledWith("Request of ticket 8 failed: Error: status 503");
  } finally {
    log.mockRestore();
  }
});

test("the poller starts the round for a request", async () => {
  vi.stubEnv("FACTORY_SCHEDULE", "poll");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const w = world();
    w.host.sayOnChange("5", "dev", ASK, T1);
    await main(w.ctx);
    expect(w.ci.started).toEqual([BUILD]);
    expect(log).toHaveBeenCalledWith("Started request rounds for tickets: 8");
  } finally {
    vi.unstubAllEnvs();
    log.mockRestore();
  }
});

// A round that ended: the cursor line it left decides which requests are new.
async function endedRound(heardUntil: string) {
  const w = world({ state: "running" });
  let r = addStep(addStep(w.ctx.record, "event", { start: true, ticket: "8", round: 1 }), "precommit-gate", { passed: true, rounds: 1, branch: "b", sha: "h", change: "5", changeUrl: "u" });
  r = { ...r, heardUntil, rounds: { review: 1, gate: 1 }, requestRounds: [{ cursor: T1, requests: [{ author: "dev", body: ASK, at: T1, on: "change" }], costAtStart: 0, tokensAtStart: { input: 0, output: 0 } }] };
  w.ctx.record = r;
  await askPerson(w.ctx, ["a person asked for changes"]);
  return w;
}
test("after a round, a request the agent read during it starts no round, and one written after the last author run does", async () => {
  const w = await endedRound(T2);
  w.host.sayOnChange("5", "dev", ASK, T2);
  expect(await pollRequests(w.ctx)).toEqual([]);
  w.host.sayOnChange("5", "dev", ASK, "2026-10-01T13:00:00Z");
  expect(await pollRequests(w.ctx)).toEqual(["8"]);
});
test("a first run with no round writes the cursor, so a request written during its risk check starts a round", async () => {
  const w = world({ state: "running", cursor: false });
  const gate = { passed: true, rounds: 1, branch: "b", sha: "h", change: "5", changeUrl: "u" };
  w.ctx.record = { ...w.ctx.record, steps: [{ step: "event", at: T1, data: { start: true, ticket: "8" } }, { step: "precommit-gate", at: T1, data: gate }] }; // the run started at T1
  w.host.sayOnChange("5", "dev", ASK, T2); // written during the risk check: before the needs-a-person comment
  await askPerson(w.ctx, ["risk"]);
  expect(await pollRequests(w.ctx)).toEqual(["8"]);
});

// Replies on the change of a work item in any other state. The clock stands two minutes after the request.
const NOW = "2026-10-01T11:02:00Z";
const T3 = "2026-10-01T11:03:00Z";
afterEach(() => vi.useRealTimers());
function other(state: FactoryState | null) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const w = fakeWorld({ state });
  w.openChange();
  w.host.sayOnChange("5", "dev", ASK, T1);
  return w;
}
const reply = (w: ReturnType<typeof other>) => w.host.changeComments("5").then((c) => c.filter((x) => x.byFactory));

test("a trusted request on the change of a blocked ticket gets one reply that ends with the cursor line, and starts no build", async () => {
  const w = other("blocked");
  expect(await replyOnChanges(w.ctx)).toEqual(["8"]);
  expect(w.mrComments).toHaveLength(1);
  expect(w.mrComments[0].startsWith("@dev ")).toBe(true);
  expect(w.mrComments[0]).toContain("factory_ready");
  expect(w.mrComments[0].endsWith(cursorLine(T1))).toBe(true);
  expect(w.ci.started).toEqual([]);
  expect(w.workItemComments).toEqual([]);
});
test.each([["needs_info", "Answer the factory's questions"], ["ready", "factory_ready"], ["done", "work is done"], [null, "has not started work"]] as const)("a request on the change of a ticket in state %s gets its own reply", async (state, sentence) => {
  const w = other(state);
  expect(await replyOnChanges(w.ctx)).toEqual(["8"]);
  expect(w.mrComments).toHaveLength(1);
  expect(w.mrComments[0]).toContain(sentence);
  expect(w.mrComments[0].endsWith(cursorLine(T1))).toBe(true);
});
test("the next call replies to nothing, and a second request after the reply gets its own reply", async () => {
  const w = other("blocked");
  await replyOnChanges(w.ctx);
  expect(await replyOnChanges(w.ctx)).toEqual([]);
  expect(await reply(w)).toHaveLength(1);
  w.host.sayOnChange("5", "dev", ASK, T3);
  vi.setSystemTime("2026-10-01T11:04:00Z");
  expect(await replyOnChanges(w.ctx)).toEqual(["8"]);
  expect(w.mrComments).toHaveLength(2);
  expect(w.mrComments[1].endsWith(cursorLine(T3))).toBe(true);
});
test("an untrusted author gets no reply", async () => {
  const w = other("blocked");
  w.tracker.trusted = async () => false;
  expect(await replyOnChanges(w.ctx)).toEqual([]);
  expect(w.mrComments).toEqual([]);
});
test("a factory comment that quotes @factory gets no reply, even from a tracker that trusts the factory", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const w = fakeWorld({ state: "blocked" });
  w.openChange();
  w.tracker.trusted = async () => true;
  w.host.sayOnChange("5", BOT, `You wrote: ${ASK}`, T1, true);
  expect(await replyOnChanges(w.ctx)).toEqual([]);
  expect(w.mrComments).toEqual([]);
});
test.each(["@factory stop", "@factory resume", "looks good"])("the comment %j gets no reply", async (body) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const w = fakeWorld({ state: "blocked" });
  w.openChange();
  w.host.sayOnChange("5", "dev", body, T1);
  expect(await replyOnChanges(w.ctx)).toEqual([]);
  expect(w.mrComments).toEqual([]);
});
test.each(["needs_approval", "running", "stopped", "waiting"] as const)("a ticket in %s is skipped here, since another path answers it", async (state) => {
  const w = other(state);
  expect(await replyOnChanges(w.ctx)).toEqual([]);
  expect(w.mrComments).toEqual([]);
});
test("recentChanges is called once with since 10 minutes before now, and comments are read only for the changes it returns", async () => {
  const w = other("blocked");
  w.host.openChange("factory/9-other", "Other", "Factory run 42: https://ci.example/runs/42", "9");
  w.host.sayOnChange("6", "dev", ASK, T0); // updated an hour before the window
  const recent = vi.spyOn(w.host, "recentChanges");
  const comments = vi.spyOn(w.host, "changeComments");
  await replyOnChanges(w.ctx);
  expect(recent.mock.calls).toEqual([[new Date(Date.parse(NOW) - REPLY_WINDOW_MS).toISOString()]]);
  expect(comments.mock.calls.map((c) => c[0])).toEqual(["5"]);
});
test("a change that fails does not stop the next", async () => {
  const w = other("blocked");
  w.tracker.tickets.get("9")!.state = "blocked";
  w.host.openChange("factory/9-other", "Other", "Factory run 42: https://ci.example/runs/42", "9");
  w.host.sayOnChange("6", "dev", ASK, T1);
  const commentChange = w.host.commentChange;
  w.host.commentChange = async (ref, text) => { if (ref === "6") throw new Error("status 503"); return commentChange(ref, text); };
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    expect(await replyOnChanges(w.ctx)).toEqual(["8"]);
    expect(log).toHaveBeenCalledWith("Reply on change 6 failed: Error: status 503");
  } finally {
    log.mockRestore();
  }
});
