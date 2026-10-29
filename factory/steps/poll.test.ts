import { expect, test } from "vitest";
import { finishCancelledStops, pollReady } from "./poll";
import { isCancelNote } from "./context";
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

// Task B5: the dashboard cancelled a pipeline that did not stop. The poller finishes the stop.
const cancelled = (ticket: string) => ({ id: `q${ticket}`, kind: "stop" as const, run: "run-1", target: "react_frontend", ticket, user: "dev", at: "2026-10-29T00:00:00Z", outcome: "cancelled" as const });
test("a cancelled stop on a running ticket sets stopped, says why, and is marked done", async () => {
  const ctx = fakeCtx({ running: 1 });
  const dash = fakeDashboard({ requests: [cancelled("r0"), { ...cancelled("9"), outcome: "stopped" }, { ...cancelled("9"), kind: "restart" }] });
  ctx.dashboard = dash;
  expect(await finishCancelledStops(ctx)).toEqual(["r0"]);
  expect(ctx.world.tracker.tickets.get("r0")!.state).toBe("stopped");
  const text = ctx.world.tracker.posted.map((p) => [p.ref, p.text]);
  expect(text).toEqual([["r0", "The run was stopped from the dashboard by @dev. The pipeline did not stop within 60 seconds, so it was cancelled. Resume is not possible. Use Restart.\n\nReason: pipeline cancelled from the dashboard"]]);
  expect(isCancelNote(text[0][1])).toBe(true);
  expect(dash.done).toEqual([["qr0", "done"]]);
});
test("a cancelled stop on a ticket no longer running is only marked done", async () => {
  const ctx = fakeCtx({ running: 0, ready: [3] });
  const dash = fakeDashboard({ requests: [cancelled("3")] });
  ctx.dashboard = dash;
  expect(await finishCancelledStops(ctx)).toEqual([]);
  expect(ctx.world.tracker.tickets.get("3")!.state).toBe("ready");
  expect(ctx.world.tracker.posted).toEqual([]);
  expect(dash.done).toEqual([["q3", "done"]]);
});
test("finishing cancelled stops does nothing while the dashboard is down", async () => {
  const ctx = fakeCtx({ running: 1 });
  const dash = fakeDashboard({ requests: [cancelled("r0")] });
  dash.down = true;
  ctx.dashboard = dash;
  expect(await finishCancelledStops(ctx)).toEqual([]);
  expect(ctx.world.tracker.tickets.get("r0")!.state).toBe("running");
});
