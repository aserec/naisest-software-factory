import { describe, expect, it } from "vitest";
import type { ControlRequest, RunEvent } from "software-factory/run-events";
import { runView, type RunViewInput } from "./run-view";

const now = new Date("2026-11-05T12:00:00Z");
const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
const ev = (type: RunEvent["type"], data: Record<string, unknown> = {}, o: Partial<RunEvent> = {}): RunEvent => ({ id: `${type}${Math.random()}`, run: "r1", at: ago(1), target: "demo", ticket: "7", type, data, ...o }) as RunEvent;
const label = (to: string) => ev("label_change", { to });
const req = (kind: ControlRequest["kind"], o: Partial<ControlRequest> = {}): ControlRequest => ({ id: `${kind}${Math.random()}`, kind, run: "r1", target: "demo", ticket: "7", user: "ann", at: ago(2), ...o });
const view = (i: Partial<RunViewInput>) => runView({ now, ...({ events: [] } as RunViewInput), ...i });

describe("actions", () => {
  const table: [string, Partial<RunViewInput>, string[]][] = [
    ["running", { events: [label("running")] }, ["stop"]],
    ["a state with the old factory_ prefix", { events: [label("factory_running")] }, ["stop"]],
    ["stopped", { events: [label("stopped")] }, ["resume", "restart"]],
    ["the newest label wins", { events: [label("stopped"), label("running")] }, ["stop"]],
    ["no label and no fallback", { events: [] }, []],
    ["no label, the tracker state fills in", { events: [], fallback: "running" }, ["stop"]],
    ["needs_approval", { events: [label("needs_approval")] }, []],
    ["blocked", { events: [label("blocked")] }, []],
    ["waiting", { events: [label("waiting")] }, []],
    ["done", { events: [label("done")] }, []],
    ["an unknown label", { events: [label("running"), label("foo")] }, []],
    ["cancelled, state still running", { events: [label("running")], requests: [req("stop", { outcome: "cancelled" })] }, ["restart"]],
    ["cancelled, state stopped", { events: [label("stopped")], requests: [req("stop", { outcome: "cancelled" })] }, ["restart"]],
    ["restarted", { events: [label("stopped")], requests: [req("restart", { outcome: "done", doneAt: ago(1) })] }, []],
    ["restarted after a cancel", { events: [label("running")], requests: [req("stop", { outcome: "cancelled" }), req("restart", { outcome: "done", doneAt: ago(1) })] }, []],
    ["a newer run exists, stopped", { events: [label("stopped")], newer: true }, []],
    ["a newer run exists, running", { events: [label("running")], newer: true }, ["stop"]],
    ["ended", { events: [label("stopped"), ev("run_end", { outcome: "restarted" })] }, []],
    ["a stop waits", { events: [label("running")], requests: [req("stop")] }, []],
    ["a resume waits", { events: [label("stopped")], requests: [req("resume")] }, []],
    ["a finished stop is not waiting", { events: [label("stopped")], requests: [req("stop", { outcome: "stopped", doneAt: ago(1) })] }, ["resume", "restart"]],
  ];
  it.each(table)("%s", (_name, input, actions) => {
    expect(view(input).actions).toEqual(actions);
  });

  it("gives a reason for every refused action", () => {
    const refused = (i: Partial<RunViewInput>) => view(i).refusals;
    expect(refused({ events: [label("needs_approval")] })).toEqual({ stop: "run is not running", resume: "run is not stopped", restart: "run is not stopped" });
    expect(refused({ events: [label("stopped")] })).toEqual({ stop: "run is not running" });
    expect(refused({ events: [label("running")], requests: [req("stop")] })).toMatchObject({ stop: "already requested", resume: "a request is already waiting" });
    expect(refused({ events: [label("running")], requests: [req("stop", { outcome: "cancelled" })] })).toEqual({ stop: "already requested", resume: "the run was cancelled, use Restart" });
    expect(refused({ events: [label("stopped"), ev("run_end")] })).toEqual({ stop: "run already ended", resume: "run already ended", restart: "run already ended" });
    expect(refused({ events: [label("stopped")], requests: [req("restart", { outcome: "done", doneAt: ago(1) })] }).restart).toBe("run already restarted");
    expect(refused({ events: [label("stopped")], newer: true })).toMatchObject({ resume: "run is not the ticket's newest run", restart: "run is not the ticket's newest run" });
  });
});

describe("the run's own facts", () => {
  it("says ended, paused, cancelled, restarted and what waits", () => {
    expect(view({ events: [label("running"), ev("run_end")] })).toMatchObject({ state: "running", ended: true, paused: false });
    expect(view({ events: [label("needs_approval")] })).toMatchObject({ ended: false, paused: true });
    const v = view({ events: [label("running")], requests: [req("stop", { outcome: "cancelled" }), req("resume")] });
    expect(v).toMatchObject({ cancelled: true, restarted: false, pending: ["resume"] });
  });
});

describe("stuck", () => {
  const limits = { "prepare-patch": 120 };
  const step = (min: number, o: Partial<RunEvent> = {}) => ev("step_start", {}, { step: "prepare-patch", at: ago(min), ...o });

  it("is stuck only after the step's limit", () => {
    expect(view({ events: [label("running"), step(119)], limits }).stuck).toBe(false);
    expect(view({ events: [label("running"), step(121)], limits }).stuck).toBe(true);
  });

  it("is never stuck when the step ended, has no limit, or there is no step", () => {
    expect(view({ events: [step(500), ev("step_end", { outcome: "next" }, { step: "prepare-patch" })], limits }).stuck).toBe(false);
    expect(view({ events: [step(500, { step: "other" })], limits }).stuck).toBe(false);
    expect(view({ events: [label("running")], limits }).stuck).toBe(false);
  });

  it("is not stuck once the run ended or paused, however long the step ran", () => {
    for (const to of ["stopped", "needs_approval", "needs_info", "blocked", "waiting"]) expect(view({ events: [step(500), label(to)], limits }).stuck, to).toBe(false);
    expect(view({ events: [step(500), ev("run_end")], limits }).stuck).toBe(false);
  });

  it("keeps the outer step as the last step while a patch step runs", () => {
    const events = [step(130, { step: "code-review" }), ev("step_start", {}, { step: "patch", at: ago(10) })];
    expect(view({ events, limits: { "code-review": 120 } })).toMatchObject({ lastStep: { step: "code-review", ended: false }, stuck: true });
  });
});
