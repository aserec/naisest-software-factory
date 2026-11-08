import { expect, test, vi } from "vitest";
import { main, pollReady } from "./poll";
import { md, noteText } from "../conversation";
import { endClosedRuns, finishCancelledStops, finishMerged, handleReadyRequests, handleRequests, restartDeadRuns } from "./poller";
import { resumeWaiting } from "./resume-waiting";
import { BOT, fakeCtx, fakeWorld, noteIn } from "./test-helpers";
import { HttpError } from "../errors";
import { fakeDashboard } from "../fakes";
import { SWITCHES, type SwitchName } from "../run-events";

const on = (o: Partial<Record<SwitchName, boolean>>) => ({ ...(Object.fromEntries(SWITCHES.map((n) => [n, true])) as Record<SwitchName, boolean>), ...o });

test("poller starts ready items up to the repo limit of 2", async () => {
  expect(await pollReady(fakeCtx({ ready: [3, 4, 5], running: 0 }))).toEqual(["3", "4"]);
});
test("retry resumes waiting runs with their saved session", async () => {
  const ctx = fakeCtx({ waiting: [{ iid: 9, sessionId: "s9" }], running: 0 });
  expect(await resumeWaiting(ctx)).toEqual(["9"]);
  expect(ctx.resumed).toEqual(["s9"]);
});

// Waiting and other active runs hold their slots.
test("poller starts nothing while the repo already has 2 active runs", async () => {
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await pollReady(fakeCtx({ ready: [3], running: 1, waiting: [{ iid: 9, sessionId: "s9" }] }))).toEqual([]);
  expect(err).toHaveBeenCalledWith(expect.stringMatching(/^1 ready ticket\(s\) wait: 2 runs are active/));
  err.mockRestore();
});
// Anyone who can comment could write the waiting line. Only the bot's own note counts.
test("retry ignores a waiting note not written by the bot and blocks the work item", async () => {
  const ctx = fakeCtx({ waiting: [{ iid: 9, sessionId: "s9" }], running: 0, noteAuthor: "dev" });
  expect(await resumeWaiting(ctx)).toEqual([]);
  expect(ctx.resumed).toEqual([]);
  expect(ctx.world.tracker.tickets.get("9")!.state).toBe("blocked");
  expect(ctx.world.cards.map((c) => c.kind)).toEqual(["blocked"]);
});
// A ticket blocked by another starts only once that one is closed, so two patches never build on each other unmerged.
test("poller skips a ticket while a ticket that blocks it is still open", async () => {
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const ctx = fakeCtx({ ready: [3, 4], running: 1 });
  ctx.world.tracker.blockers.set("3", ["7"]); // 7 is not in the fake, so it counts as open
  expect(await pollReady(ctx)).toEqual(["4"]);
  expect(err).toHaveBeenCalledWith("Ticket 3 waits: blocked by 7, still open");
  ctx.world.tracker.blockers.set("3", []);
  expect(await pollReady(ctx, ["4"])).toEqual(["3"]);
  err.mockRestore();
});
// A non-developer's label must not take a free slot from a valid item, every minute.
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

test("a ticket whose start fails is skipped and the next ticket still starts", async () => {
  const ctx = fakeCtx({ ready: [3, 4], running: 0 });
  const start = ctx.ci.start.bind(ctx.ci);
  ctx.ci.start = async (job) => { if (job.ticket === "3") throw new Error("status 503"); return start(job); };
  expect(await pollReady(ctx)).toEqual(["4"]);
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
  expect(await resumeWaiting(ctx)).toEqual([]);
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
  expect(text).toEqual([["r0", noteText({ kind: "cancelled", user: "dev" })]]);
  expect(noteIn(text[0][1], "stopped")?.kind).toBe("cancelled");
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
test("between local runs a stop no cancel reached counts as cancelled; during a run it waits", async () => {
  const waiting = { ...cancelled("r0"), outcome: undefined };
  const ctx = fakeCtx({ running: 1 });
  const dash = fakeDashboard({ requests: [waiting] });
  ctx.dashboard = dash;
  expect(await finishCancelledStops(ctx)).toEqual([]);
  expect(await finishCancelledStops(ctx, true)).toEqual(["r0"]);
  expect(ctx.world.tracker.tickets.get("r0")!.state).toBe("stopped");
  expect(dash.done).toEqual([["qr0", "cancelled"], ["qr0", "done"]]);
});
// local-factory.sh polls between its runs: a running ticket there lost its run when the loop stopped.
const deadRunCtx = () => {
  const ctx = fakeCtx({ running: 1 });
  const dash = fakeDashboard();
  dash.send({ id: "e1", run: "dead-run", target: "react_frontend", ticket: "r0", at: new Date(Date.now() - 60_000).toISOString(), type: "run_start", data: {} } as never);
  ctx.dashboard = dash;
  return { ctx, dash };
};
test("between local runs a ticket whose run died starts a new run for the person who set it ready", async () => {
  const { ctx, dash } = deadRunCtx();
  expect(await restartDeadRuns(ctx)).toEqual(["r0"]);
  expect(ctx.world.tracker.tickets.get("r0")!.state).toBe("ready");
  expect(ctx.world.ci.started).toEqual([{ kind: "build", ticket: "r0" }]);
  const note = ctx.world.tracker.posted.find((p) => p.ref === "r0")!.text;
  expect(noteIn(note, "readyFor")).toMatchObject({ person: "user-r0" });
  expect(dash.events.filter((e) => e.type === "run_end").map((e) => [e.run, e.data])).toEqual([["dead-run", { outcome: "restarted" }]]);
});
test("a dead run whose ready no trusted person set is blocked, not started", async () => {
  const { ctx } = deadRunCtx();
  ctx.tracker.trusted = async () => false;
  expect(await restartDeadRuns(ctx)).toEqual([]);
  expect(ctx.world.tracker.tickets.get("r0")!.state).toBe("blocked");
  expect(ctx.world.ci.started).toEqual([]);
});
test("finishing cancelled stops does nothing while the dashboard is down", async () => {
  const ctx = fakeCtx({ running: 1 });
  const dash = fakeDashboard({ requests: [cancelled("r0")] });
  dash.down = true;
  ctx.dashboard = dash;
  expect(await finishCancelledStops(ctx)).toEqual([]);
  expect(ctx.world.tracker.tickets.get("r0")!.state).toBe("running");
});

// Task B6: resume and restart requests from the dashboard. The poller serves them before it starts new runs.
const request = (kind: "resume" | "restart" | "ready", ticket: string, o: object = {}) => ({ id: `q${ticket}`, kind, run: "run-1", target: "react_frontend", ticket, user: "ana", at: new Date().toISOString(), ...o });
const stoppedCtx = (notes: string[]) => {
  const ctx = fakeCtx({ running: 1 });
  ctx.world.tracker.tickets.set("7", { ...ctx.world.tracker.tickets.get("9")!, ref: "7", state: "stopped" });
  // Newest first, as the tracker gives them.
  ctx.tracker.comments = async () => notes.map((body) => ({ author: BOT, byFactory: true, body, at: "2026-10-29T00:00:00Z" }));
  return ctx;
};
const personStop = noteText({ kind: "stopped", run: "55", step: "prepare-patch", reason: "stopped by @factory stop" });
test("a resume request on a stopped ticket starts one build with the stopped pipeline and is marked done", async () => {
  const ctx = stoppedCtx([personStop]);
  const dash = fakeDashboard({ requests: [request("resume", "7")] });
  ctx.dashboard = dash;
  await handleRequests(ctx);
  expect(ctx.world.ci.started).toEqual([{ kind: "build", ticket: "7", buildRun: "55" }]);
  expect(dash.done).toEqual([["q7", "done"]]);
});
test("a resume request on a running ticket, or after a cancel, is refused and starts nothing", async () => {
  const running = stoppedCtx([personStop]);
  const dash = fakeDashboard({ requests: [request("resume", "r0")] });
  running.dashboard = dash;
  await handleRequests(running);
  expect(running.world.ci.started).toEqual([]);
  expect(dash.done).toEqual([["qr0", "refused"]]);
  // The cancel is newer than the stop: the stopped pipeline saved nothing after it.
  const cancelled = stoppedCtx([noteText({ kind: "cancelled", user: "dev" }), personStop]);
  const dash2 = fakeDashboard({ requests: [request("resume", "7")] });
  cancelled.dashboard = dash2;
  await handleRequests(cancelled);
  expect(cancelled.world.ci.started).toEqual([]);
  expect(dash2.done).toEqual([["q7", "refused"]]);
});
test("a restart request on a ticket that is not stopped is refused", async () => {
  const ctx = stoppedCtx([]);
  const dash = fakeDashboard({ requests: [request("restart", "r0")] });
  ctx.dashboard = dash;
  await handleRequests(ctx);
  expect(ctx.world.ci.started).toEqual([]);
  expect(ctx.world.tracker.tickets.get("r0")!.state).toBe("running");
  expect(dash.done).toEqual([["qr0", "refused"]]);
});
test("requests already answered are left alone, and handleRequests does nothing while the dashboard is down", async () => {
  const ctx = stoppedCtx([personStop]);
  const dash = fakeDashboard({ requests: [request("restart", "7", { outcome: "done" }), request("resume", "7", { outcome: "refused" })] });
  ctx.dashboard = dash;
  await handleRequests(ctx);
  expect(ctx.world.ci.started).toEqual([]);
  expect(dash.done).toEqual([]);
  const down = fakeDashboard({ requests: [request("resume", "7")] });
  down.down = true;
  ctx.dashboard = down;
  await expect(handleRequests(ctx)).resolves.toEqual([]);
  expect(ctx.world.ci.started).toEqual([]);
  expect(ctx.world.tracker.tickets.get("7")!.state).toBe("stopped");
});
// R31: a ready the factory set counts only for a recent restart of that ticket, and as that restart's user.
test("poller starts a ticket the factory set ready only for a recent restart request by a trusted person", async () => {
  const ctx = fakeCtx({ ready: [3, 4, 5], running: 0 });
  ctx.tracker.startedBy = async () => BOT;
  ctx.tracker.trusted = async (actor) => actor === "ana";
  const old = new Date(Date.now() - 16 * 60_000).toISOString();
  ctx.dashboard = fakeDashboard({ requests: [request("restart", "3", { outcome: "done" }), request("restart", "4", { at: old, outcome: "done" }), request("restart", "5", { user: "eve" })] });
  expect(await pollReady(ctx)).toEqual(["3"]);
});
// Dashboard Set to Ready: the factory sets a blocked ticket ready for a trusted person, and that ready counts as theirs.
test("a ready request sets a blocked ticket ready for a trusted person, and the poller starts it as theirs", async () => {
  const ctx = stoppedCtx([]);
  ctx.world.tracker.tickets.get("7")!.state = "blocked";
  ctx.tracker.trusted = async (actor) => actor === "ana";
  const dash = fakeDashboard({ requests: [request("ready", "7"), request("ready", "r0"), request("ready", "8", { user: "eve" })] });
  ctx.world.tracker.tickets.set("8", { ...ctx.world.tracker.tickets.get("7")!, ref: "8", state: "blocked" });
  ctx.dashboard = dash;
  expect(await handleReadyRequests(ctx)).toEqual(["7"]); // it sets the state only; pollReady starts the run
  expect(ctx.world.tracker.tickets.get("7")!.state).toBe("ready");
  expect(ctx.world.tracker.tickets.get("8")!.state).toBe("blocked");
  expect(dash.done).toEqual([["q7", "done"], ["qr0", "refused"], ["q8", "refused"]]);
  ctx.tracker.startedBy = async () => BOT;
  ctx.dashboard = fakeDashboard({ requests: [request("ready", "7", { outcome: "done" })] });
  expect(await pollReady(ctx)).toEqual(["7"]);
});
// A ticket deleted on GitHub: its GraphQL error must refuse the request once, not fail it every minute.
test("a ready request for a deleted GitHub issue is refused", async () => {
  const ctx = stoppedCtx([]);
  ctx.tracker.ticket = async () => { throw new HttpError("GitHub GraphQL failed: Could not resolve to an Issue with the number of 326.", 404); };
  const dash = fakeDashboard({ requests: [request("ready", "326")] });
  ctx.dashboard = dash;
  expect(await handleReadyRequests(ctx)).toEqual([]);
  expect(dash.done).toEqual([["q326", "refused"]]);
});
// The local factory polls with --list only. Set to Ready must still reach the tracker there, and print just the ticket.
test("the --list poll sets a requested ticket ready and lists it to run", async () => {
  vi.stubEnv("FACTORY_SCHEDULE", "poll");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const argv = process.argv;
  process.argv = [...argv, "--list"];
  try {
    const ctx = stoppedCtx([]);
    ctx.world.tracker.tickets.get("7")!.state = "blocked";
    ctx.tracker.trusted = async (actor) => actor === "ana";
    ctx.tracker.startedBy = async () => BOT;
    const dash = fakeDashboard({ requests: [request("ready", "7")] });
    ctx.dashboard = dash;
    await main(ctx);
    expect(ctx.world.tracker.tickets.get("7")!.state).toBe("ready");
    expect(dash.done).toEqual([["q7", "done"]]);
    expect(log.mock.calls.map((c) => c[0])).toEqual(["7"]);
  } finally {
    process.argv = argv;
    log.mockRestore();
    vi.unstubAllEnvs();
  }
});
// Only local-factory.sh polls between its runs. In CI a running ticket's pipeline may still run, so the CI poll leaves it.
test("the --list poll lists a dead run's ticket once to run again; the CI poll leaves running tickets alone", async () => {
  vi.stubEnv("FACTORY_SCHEDULE", "poll");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const argv = process.argv;
  try {
    const ci = deadRunCtx().ctx;
    await main(ci);
    expect(ci.world.tracker.tickets.get("r0")!.state).toBe("running");
    log.mockClear();
    process.argv = [...argv, "--list"];
    const local = deadRunCtx().ctx;
    await main(local);
    expect(log.mock.calls.map((c) => c[0])).toEqual(["r0"]);
  } finally {
    process.argv = argv;
    log.mockRestore();
    err.mockRestore();
    vi.unstubAllEnvs();
  }
});
// The --list poll does the whole tick: a dashboard resume prints as ticket:build run, which local-run.sh resumes.
test("the --list poll runs dashboard resumes too and lists them with their build run", async () => {
  vi.stubEnv("FACTORY_SCHEDULE", "poll");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const argv = process.argv;
  process.argv = [...argv, "--list"];
  try {
    const ctx = stoppedCtx([personStop]);
    ctx.world.tracker.tickets.delete("r0"); // between local runs a running ticket is a dead run, which this poll would start again
    const dash = fakeDashboard({ requests: [request("resume", "7")] });
    ctx.dashboard = dash;
    await main(ctx);
    expect(dash.done).toEqual([["q7", "done"]]);
    expect(log.mock.calls.map((c) => c[0])).toEqual(["7:55"]);
  } finally {
    process.argv = argv;
    log.mockRestore();
    err.mockRestore();
    vi.unstubAllEnvs();
  }
});
// F-P1: under ci: local no webhook hears a person's merge; the poller starts the finish run with apply skipped.
test("a change a person merged by hand starts the finish run, once the webhook had its time", async () => {
  const w = fakeWorld({ state: "needs_approval" });
  w.openChange();
  w.host.mergeByPerson("5", new Date().toISOString());
  expect(await finishMerged(w.ctx)).toEqual([]); // just merged: the webhook's turn
  w.host.mergeByPerson("5", "2026-10-01T00:00:00Z");
  expect(await finishMerged(w.ctx)).toEqual(["8"]);
  expect(w.ci.started).toEqual([{ kind: "finish", ticket: "8", change: "5", buildRun: "41", skipApply: true }]);
  expect(w.states).toEqual(["running"]);
  expect(await finishMerged(w.ctx)).toEqual([]); // running now: no second start
});
// R41: the comment first, so a lost comment never leaves a stopped ticket whose newest note is an older stop.
test("a cancelled stop posts its comment before it sets the ticket stopped", async () => {
  const ctx = fakeCtx({ running: 1 });
  ctx.dashboard = fakeDashboard({ requests: [cancelled("r0")] });
  const order: string[] = [];
  const { comment, setState } = ctx.tracker;
  ctx.tracker.comment = async (ref, text) => (order.push("comment"), comment(ref, text));
  ctx.tracker.setState = async (ref, state) => (order.push(state), setState(ref, state));
  await finishCancelledStops(ctx);
  expect(order).toEqual(["comment", "stopped"]);
});

// Fix round 1 for B6 (R42).
test("the poller flushes the dashboard at the end, also after an error, and does not start a restarted ticket twice", async () => {
  vi.stubEnv("FACTORY_SCHEDULE", "poll");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const ctx = stoppedCtx([personStop]);
    ctx.tracker.startedBy = async () => BOT; // the restart's ready
    const dash = fakeDashboard({ requests: [request("restart", "7")] });
    let flushed = 0;
    dash.flush = async () => void flushed++;
    ctx.dashboard = dash;
    await main(ctx);
    expect(ctx.world.ci.started).toEqual([{ kind: "build", ticket: "7" }]);
    expect(flushed).toBe(1);
    ctx.tracker.list = async () => { throw new Error("tracker down"); };
    await expect(main(ctx)).rejects.toThrow("tracker down");
    expect(flushed).toBe(2);
  } finally {
    vi.unstubAllEnvs();
    log.mockRestore();
  }
});
test("a failed request does not stop the others, and a request for a ticket that is gone is refused", async () => {
  const ctx = stoppedCtx([personStop]);
  ctx.world.tracker.tickets.set("6", { ...ctx.world.tracker.tickets.get("7")!, ref: "6" });
  const start = ctx.ci.start;
  ctx.ci.start = async (run) => { if (run.ticket === "6") throw new Error("CI is down"); return start(run); };
  const dash = fakeDashboard({ requests: [request("resume", "404"), request("restart", "6"), request("resume", "7")] });
  ctx.dashboard = dash;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  expect(await handleRequests(ctx)).toEqual(["7"]);
  expect(log.mock.calls.map((c) => c[0])).toEqual(["Request q6 (restart of ticket 6) failed: Error: CI is down"]);
  log.mockRestore();
  expect(dash.done).toEqual([["q404", "refused"], ["q7", "done"]]);
  // The failed start leaves the old run open on the dashboard.
  expect(dash.events.filter((e) => e.type === "run_end")).toEqual([]);
});
test("run_end restarted names the old run and its ticket, not the poller's pipeline or job", async () => {
  const ctx = stoppedCtx([]);
  ctx.ci.vars = { ...ctx.ci.vars, run: "900", job: "poll" };
  const dash = fakeDashboard({ requests: [request("restart", "7")] });
  ctx.dashboard = dash;
  await handleRequests(ctx);
  const [end] = dash.events;
  expect(end).toMatchObject({ type: "run_end", run: "run-1", ticket: "7", data: { outcome: "restarted" } });
  expect(end.pipeline).toBeUndefined();
  expect(end.job).toBeUndefined();
});
test("a restart request dated in the future does not make a factory-set ready trusted", async () => {
  const ctx = fakeCtx({ ready: [3], running: 0 });
  ctx.tracker.startedBy = async () => BOT;
  ctx.tracker.trusted = async (actor) => actor === "ana";
  ctx.dashboard = fakeDashboard({ requests: [request("restart", "3", { at: new Date(Date.now() + 60 * 60_000).toISOString() })] });
  expect(await pollReady(ctx)).toEqual([]);
});
// Final review: a restart whose start failed leaves the ticket ready. The next poll starts it once and ends the old run.
test("a restart whose start failed is started by the next poll, once, and then ends the old run", async () => {
  vi.stubEnv("FACTORY_SCHEDULE", "poll");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const ctx = stoppedCtx([]);
    ctx.tracker.startedBy = async () => BOT; // the restart's ready
    const dash = fakeDashboard({ requests: [request("restart", "7")] });
    ctx.dashboard = dash;
    const start = ctx.ci.start;
    let down = true;
    ctx.ci.start = async (run) => { if (down) throw new Error("CI is down"); return start(run); };
    await main(ctx);
    expect(ctx.world.tracker.tickets.get("7")!.state).toBe("ready");
    expect(dash.done).toEqual([]);
    down = false;
    await main(ctx); // the request is still pending: pollReady must leave the ticket to it
    expect(ctx.world.ci.started).toEqual([{ kind: "build", ticket: "7" }]);
    expect(dash.done).toEqual([["q7", "done"]]);
    expect(dash.events.filter((e) => e.type === "run_end")).toMatchObject([{ run: "run-1", data: { outcome: "restarted" } }]);
  } finally {
    vi.unstubAllEnvs();
    log.mockRestore();
  }
});

// Task F1.
// R45: the dashboard checked the person's role on the factory project; the target project's trust is checked here.
test("a resume request by a person the target project does not trust is refused and starts nothing", async () => {
  const ctx = stoppedCtx([personStop]);
  ctx.tracker.trusted = async (actor) => actor !== "ana";
  const dash = fakeDashboard({ requests: [request("resume", "7")] });
  ctx.dashboard = dash;
  expect(await handleRequests(ctx)).toEqual([]);
  expect(ctx.world.ci.started).toEqual([]);
  expect(dash.done).toEqual([["q7", "refused"]]);
});
test("a restart of a run stopped at apply closes its change with a comment that links the new run", async () => {
  const ctx = stoppedCtx([noteText({ kind: "stopped", run: "55", step: "apply", reason: "switch off apply", change: "5", buildRun: "41" })]);
  const { ref } = await ctx.codeHost.openChange("factory/7-x", "Change", "Text.", "7");
  ctx.dashboard = fakeDashboard({ requests: [request("restart", "7")] });
  expect(await handleRequests(ctx)).toEqual(["7"]);
  expect(ref).toBe("5");
  expect(ctx.world.host.mrComments).toEqual([md("🚫", "Change closed", "This change was closed because @ana restarted the run from the dashboard.", "**New run:** https://ci.example/runs/new")]);
  expect((await ctx.codeHost.change("5")).open).toBe(false);
  // A run that stopped before apply has no change to close.
  const other = stoppedCtx([personStop]);
  other.dashboard = fakeDashboard({ requests: [request("restart", "7")] });
  await handleRequests(other);
  expect(other.world.host.mrComments).toEqual([]);
});
// R47: a restart that could not start within RESTART_MS stops the ticket again instead of leaving a ready the event step refuses.
test("a restart retry older than 15 minutes starts nothing, stops the ticket again and is refused", async () => {
  const ctx = stoppedCtx([]);
  ctx.world.tracker.tickets.get("7")!.state = "ready";
  ctx.tracker.startedBy = async () => BOT; // the restart's ready
  const dash = fakeDashboard({ requests: [request("restart", "7", { at: new Date(Date.now() - 16 * 60_000).toISOString() })] });
  ctx.dashboard = dash;
  expect(await handleRequests(ctx)).toEqual([]);
  expect(ctx.world.ci.started).toEqual([]);
  expect(ctx.world.tracker.tickets.get("7")!.state).toBe("stopped");
  expect(ctx.world.tracker.posted.map((p) => p.text)).toEqual([md("⚠️", "Restart failed", "The restart could not start a new run within 15 minutes. The ticket is stopped again. Press **Restart** on the dashboard to try again.")]);
  expect(dash.done).toEqual([["q7", "refused"]]);
  expect(dash.events.filter((e) => e.type === "run_end")).toEqual([]);
});

// The poller ends runs with no step running whose work item or change a person closed.
const closedWorld = (state: "needs_approval" | "stopped" | "waiting" | "running" | "done", o: { open?: boolean; note?: string } = {}) => {
  const ctx = fakeCtx({ running: 0 });
  const w = ctx.world;
  const t = w.tracker.tickets.get("8")!;
  Object.assign(t, { state, open: o.open ?? true });
  w.openChange(); // change 5 of ticket 8
  if (o.note) ctx.tracker.comments = async () => [{ author: BOT, byFactory: true, body: o.note!, at: "2026-10-29T00:00:00Z" }];
  return { ctx, w, t };
};
test("a closed needs_approval ticket loses its state and its open change is closed with a comment", async () => {
  const { ctx, w, t } = closedWorld("needs_approval", { open: false });
  expect(await endClosedRuns(ctx)).toEqual(["8"]);
  expect(t.state).toBeUndefined();
  expect(w.host.changes.get("5")!.open).toBe(false);
  expect(w.mrComments).toEqual([md("🚫", "Change closed", "This merge request was closed because a person closed work item #8.")]);
});
test("an open needs_approval ticket whose change was closed unmerged is blocked", async () => {
  const { ctx, w, t } = closedWorld("needs_approval");
  w.host.close("5", "ann");
  expect(await endClosedRuns(ctx)).toEqual(["8"]);
  expect(t.state).toBe("blocked");
  expect(w.workItemComments.at(-1)).toContain("The merge request https://host.example/changes/5 was closed without a merge by ann.");
});
test("a closed done ticket, and a closed ticket whose change merged, are left alone", async () => {
  const done = closedWorld("done", { open: false });
  expect(await endClosedRuns(done.ctx)).toEqual([]);
  expect(done.t.state).toBe("done");
  // A person merged it: the closing line closed the ticket, and the finish run takes it from here.
  const merged = closedWorld("needs_approval", { open: false });
  merged.w.host.mergeByPerson("5");
  expect(await endClosedRuns(merged.ctx)).toEqual([]);
  expect(merged.t.state).toBe("needs_approval");
});
// Regression: the factory's merge closes the ticket while verify still runs, up to an hour.
test("a running ticket whose change merged is not ended by the poller", async () => {
  const { ctx, w, t } = closedWorld("running", { open: false });
  w.host.mergeByPerson("5");
  expect(await endClosedRuns(ctx)).toEqual([]);
  expect(t.state).toBe("running");
  expect(w.tracker.cleared).toEqual([]);
});
// Regression: before the push, the newest change is an older run's.
test("a waiting or stopped ticket that paused before the push is not blocked for an older run's closed change", async () => {
  const waiting = closedWorld("waiting");
  waiting.w.host.close("5");
  expect(await endClosedRuns(waiting.ctx)).toEqual([]);
  expect(waiting.t.state).toBe("waiting");
  const early = closedWorld("stopped", { note: personStop });
  early.w.host.close("5");
  expect(await endClosedRuns(early.ctx)).toEqual([]);
  expect(early.t.state).toBe("stopped");
  const atApply = closedWorld("stopped", { note: noteText({ kind: "stopped", run: "55", step: "apply", reason: "switch off apply", change: "5", buildRun: "55" }) });
  atApply.w.host.close("5");
  expect(await endClosedRuns(atApply.ctx)).toEqual(["8"]);
  expect(atApply.t.state).toBe("blocked");
});
test("a closed stopped ticket paused before the push ends even when an older run's change merged", async () => {
  const { ctx, w, t } = closedWorld("stopped", { open: false, note: personStop });
  w.host.mergeByPerson("5");
  expect(await endClosedRuns(ctx)).toEqual(["8"]);
  expect(t.state).toBeUndefined();
});
test("a closed waiting ticket ends, and one failed ticket does not stop the others", async () => {
  const { ctx, w, t } = closedWorld("waiting", { open: false });
  w.tracker.tickets.set("10", { ...t, ref: "10", state: "stopped" });
  const ticket = ctx.tracker.ticket;
  ctx.tracker.ticket = async (ref) => { if (ref === "10") throw new Error("status 502"); return ticket(ref); };
  expect(await endClosedRuns(ctx)).toEqual(["8"]);
  expect(t.state).toBeUndefined();
});

// The poller answers a request on the change of a ticket in any other state.
test("in one poll, a request on the change of a blocked ticket sets it ready and gets no reply on the change", async () => {
  vi.stubEnv("FACTORY_SCHEDULE", "poll");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const ctx = fakeCtx({ running: 0 });
    ctx.world.tracker.tickets.get("8")!.state = "blocked";
    ctx.world.openChange();
    ctx.world.host.sayOnChange("5", "dev", "@factory fix the 409");
    await main(ctx);
    expect(ctx.world.tracker.tickets.get("8")!.state).toBe("ready");
    expect(ctx.world.mrComments).toEqual([]);
  } finally {
    vi.unstubAllEnvs();
    log.mockRestore();
  }
});
test("the poller replies to a request on the change of a done ticket and logs it", async () => {
  vi.stubEnv("FACTORY_SCHEDULE", "poll");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const ctx = fakeCtx({ running: 0 });
    ctx.world.tracker.tickets.get("8")!.state = "done";
    ctx.world.openChange();
    ctx.world.host.sayOnChange("5", "dev", "@factory fix the 409");
    await main(ctx);
    expect(ctx.world.mrComments).toHaveLength(1);
    expect(log).toHaveBeenCalledWith("Replied to requests on changes of tickets: 8");
  } finally {
    vi.unstubAllEnvs();
    log.mockRestore();
  }
});
test("an error in the replies is logged and the tick goes on", async () => {
  vi.stubEnv("FACTORY_SCHEDULE", "poll");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const ctx = fakeCtx({ running: 0 });
    ctx.codeHost.recentChanges = async () => { throw new Error("status 503"); };
    await main(ctx);
    expect(log).toHaveBeenCalledWith("Replies on changes failed: Error: status 503");
    expect(log).toHaveBeenCalledWith("Started build runs for tickets: none");
  } finally {
    vi.unstubAllEnvs();
    log.mockRestore();
  }
});
