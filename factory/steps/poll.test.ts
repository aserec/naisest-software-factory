import { expect, test } from "vitest";
import { pollReady } from "./poll";
import { retryWaiting } from "./retry-waiting";
import { fakeCtx } from "./test-helpers";

test("poller starts ready items up to the repo limit of 2", async () => {
  expect(await pollReady(fakeCtx({ ready: [3, 4, 5], running: 0 }))).toEqual([3, 4]);
});
test("retry resumes waiting runs with their saved session", async () => {
  const ctx = fakeCtx({ waiting: [{ iid: 9, sessionId: "s9" }], running: 0 });
  expect(await retryWaiting(ctx)).toEqual([9]);
  expect(ctx.resumed).toEqual(["s9"]);
});

// Waiting and other active runs hold their slots.
test("poller starts nothing while the repo already has 2 active runs", async () => {
  expect(await pollReady(fakeCtx({ ready: [3], running: 1, waiting: [{ iid: 9, sessionId: "s9" }] }))).toEqual([]);
});
// Anyone who can comment could write the waiting line. Only the bot's own note counts.
test("retry ignores a waiting note not written by the bot and blocks the work item", async () => {
  const ctx = fakeCtx({ waiting: [{ iid: 9, sessionId: "s9" }], running: 0, noteAuthor: 42 });
  expect(await retryWaiting(ctx)).toEqual([]);
  expect(ctx.resumed).toEqual([]);
  expect(ctx.world.labels).toEqual(["factory_blocked"]);
  expect(ctx.world.cards.map((c) => c.kind)).toEqual(["blocked"]);
});
