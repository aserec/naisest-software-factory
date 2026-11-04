import { expect, test, vi } from "vitest";
import { main } from "./poll";
import { cursorLine } from "../requests";
import { fakeWorld, BOT } from "./test-helpers";
import { pollRequests } from "./requests";
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
  await pollRequests(w.ctx);
  expect(w.workItemComments).toHaveLength(2); // the cursor line and the reply; ticket 9 stopped: answered although 8 threw
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
