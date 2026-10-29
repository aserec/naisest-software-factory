import { expect, test } from "vitest";
import { pollReady } from "./poll";
import { retryWaiting } from "./retry-waiting";
import { BOT, fakeCtx } from "./test-helpers";
import { fakeDashboard } from "../fakes";
import { SWITCHES, type SwitchName } from "../run-events";

const on = (o: Partial<Record<SwitchName, boolean>>) => ({ ...(Object.fromEntries(SWITCHES.map((n) => [n, true])) as Record<SwitchName, boolean>), ...o });

test("poller starts ready items up to the repo limit of 2", async () => {
  expect(await pollReady(fakeCtx({ ready: [3, 4, 5], running: 0 }))).toEqual(["3", "4"]);
});
test("retry resumes waiting runs with their saved session", async () => {
  const ctx = fakeCtx({ waiting: [{ iid: 9, sessionId: "s9" }], running: 0 });
  expect(await retryWaiting(ctx)).toEqual(["9"]);
  expect(ctx.resumed).toEqual(["s9"]);
});

// Waiting and other active runs hold their slots.
test("poller starts nothing while the repo already has 2 active runs", async () => {
  expect(await pollReady(fakeCtx({ ready: [3], running: 1, waiting: [{ iid: 9, sessionId: "s9" }] }))).toEqual([]);
});
// Anyone who can comment could write the waiting line. Only the bot's own note counts.
test("retry ignores a waiting note not written by the bot and blocks the work item", async () => {
  const ctx = fakeCtx({ waiting: [{ iid: 9, sessionId: "s9" }], running: 0, noteAuthor: "dev" });
  expect(await retryWaiting(ctx)).toEqual([]);
  expect(ctx.resumed).toEqual([]);
  expect(ctx.world.tracker.tickets.get("9")!.state).toBe("blocked");
  expect(ctx.world.cards.map((c) => c.kind)).toEqual(["blocked"]);
});
// A non-developer's label must not take a free slot from a valid item, every 5 minutes.
test("poller skips tickets set ready by a person who may not command the factory", async () => {
  expect(await pollReady(fakeCtx({ ready: [3, 4], running: 1, nonDeveloper: [3] }))).toEqual(["4"]);
});
// The watcher's own tickets are set ready by the factory. Only those may start without a person.
test("poller starts a watcher ticket the factory set ready, but no other ticket the factory set ready", async () => {
  const ctx = fakeCtx({ ready: [3, 4], running: 0 });
  ctx.world.tracker.tickets.get("3")!.marks = ["watcher"];
  ctx.tracker.startedBy = async () => BOT;
  ctx.tracker.trusted = async (actor) => actor !== BOT; // the factory may not command itself
  expect(await pollReady(ctx)).toEqual(["3"]);
});

// Task B4: new runs only while new_runs is on. An unreachable dashboard counts as off for new runs.
test("poller starts nothing while new_runs is off or the dashboard is down", async () => {
  const off = fakeCtx({ ready: [3], running: 0 });
  off.dashboard = fakeDashboard({ switches: on({ new_runs: false }) });
  expect(await pollReady(off)).toEqual([]);
  const down = fakeCtx({ ready: [3], running: 0 });
  (down.dashboard as ReturnType<typeof fakeDashboard>).down = true;
  expect(await pollReady(down)).toEqual([]);
});
test("retry resumes nothing while retry is off", async () => {
  const ctx = fakeCtx({ waiting: [{ iid: 9, sessionId: "s9" }], running: 0 });
  ctx.dashboard = fakeDashboard({ switches: on({ retry: false }) });
  expect(await retryWaiting(ctx)).toEqual([]);
});
