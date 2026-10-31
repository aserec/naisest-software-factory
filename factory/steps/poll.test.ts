import { expect, test } from "vitest";
import { pollReady } from "./poll";
import { retryWaiting } from "./retry-waiting";
import { BOT, fakeCtx } from "./test-helpers";

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
