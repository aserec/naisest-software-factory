import { randomUUID } from "node:crypto";
import type { ControlRequest, ControlState, RunEvent } from "software-factory/run-events";
import { afterEach, describe, expect, it, vi } from "vitest";

// The dispatch route starts a run through GitLab: the test keeps the targets it was asked to start.
const started = vi.hoisted(() => [] as string[]);
vi.mock("@/server/gitlab-instance", () => ({ getCi: () => ({ startDispatch: async (target: string) => void started.push(target) }) }));

process.env.DASHBOARD_DB = ":memory:";
process.env.FACTORY_DASHBOARD_TOKEN = "secret-token";

const { getDb } = await import("@/server/db-instance");
const { POST: postEvents } = await import("../events/route");
const { GET: getControl } = await import("./control/route");
const { POST: postDone } = await import("./requests/[id]/done/route");

const auth = { authorization: "Bearer secret-token" };
const ev = (type: RunEvent["type"], data: Record<string, unknown>, run = "r1"): RunEvent => ({ id: randomUUID(), run, at: new Date().toISOString(), target: "t", ticket: "T-1", type, data });
const send = (events: unknown, headers: Record<string, string> = auth) => postEvents(new Request("http://x/api/events", { method: "POST", headers, body: JSON.stringify(events) }));
const control = (run: string, headers: Record<string, string> = auth) => getControl(new Request(`http://x/api/factory/control?target=t&run=${run}`, { headers }));
const state = async (run: string) => (await control(run)).json() as Promise<ControlState>;
const done = (id: string, outcome: string) => postDone(new Request("http://x", { method: "POST", headers: auth, body: JSON.stringify({ outcome }) }), { params: Promise.resolve({ id }) });
const ask = (kind: ControlRequest["kind"], run: string) => {
  const r = getDb().request({ kind, run, target: "t", ticket: "T-1", user: "ann" });
  if ("refused" in r) throw new Error(r.refused);
  return r;
};

afterEach(() => vi.useRealTimers());

describe("POST /api/events", () => {
  it("refuses a missing or wrong token of the same length", async () => {
    expect((await send([], {})).status).toBe(401);
    expect((await send([], { authorization: "Bearer secret-tokeX" })).status).toBe(401);
  });

  it("refuses more than 500 events", async () => {
    const r = await send(Array.from({ length: 501 }, () => ev("run_start", {})));
    expect(r.status).toBe(400);
  });

  it("names the first bad event", async () => {
    const r = await send([ev("run_start", {}), ev("run_start", {}), { ...ev("run_start", {}), id: "nope" }]);
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toContain("2");
  });

  it("refuses the dashboard's own audit types and names the event", async () => {
    for (const type of ["stop", "resume", "restart", "switch_change"] as const) {
      const r = await send([ev("run_start", {}, "own"), ev(type, { user: "x", name: "retry", scope: "*", on: false }, "own")]);
      expect([r.status, ((await r.json()) as { error: string }).error]).toEqual([400, `event 1 has type ${type}, which only the dashboard writes`]);
    }
    expect(getDb().events({ run: "own" }).events).toEqual([]);
  });

  it("drops data keys the event type does not know", async () => {
    const call = ev("tool_call", { name: "x", input: "i", result: "r", ms: 1, ok: true, extra: "secret" }, "strip");
    expect((await send([call])).status).toBe(200);
    expect(getDb().events({ run: "strip" }).events[0].data).toEqual({ name: "x", input: "i", result: "r", ms: 1, ok: true });
  });

  it("stores good events", async () => {
    const r = await send([ev("run_start", {}, "store"), ev("step_start", {}, "store")]);
    expect(await r.json()).toEqual({ added: 2 });
    expect(getDb().events({ run: "store" }).events).toHaveLength(2);
  });
});

describe("GET /api/factory/control", () => {
  it("refuses a call without the token", async () => {
    expect((await control("r1", {})).status).toBe(401);
  });

  it("sets stop for the run with a pending stop only", async () => {
    getDb().addEvents([ev("run_start", {}, "ra")]);
    ask("stop", "ra");
    expect((await state("ra")).stop).toBe(true);
    expect((await state("rb")).stop).toBe(false);
  });

  it("returns a cancelled stop in requests without stop", async () => {
    getDb().addEvents([ev("run_start", {}, "rc")]);
    const r = ask("stop", "rc");
    await done(r.id, "cancelled");
    const s = await state("rc");
    expect(s.stop).toBe(false);
    expect(s.requests.map((q) => q.id)).toContain(r.id);
  });

  it("returns a pending resume and keeps a restart for 15 minutes after it is done", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T10:00:00Z"));
    const stopped = (run: string) => getDb().addEvents([ev("step_end", { outcome: "stopped" }, run)]);
    stopped("rr1");
    stopped("rr2");
    stopped("rr3");
    const resume = ask("resume", "rr3");
    const recent = ask("restart", "rr1");
    const old = ask("restart", "rr2");
    await done(old.id, "done");
    vi.setSystemTime(new Date("2026-01-01T10:10:00Z"));
    await done(recent.id, "done");
    vi.setSystemTime(new Date("2026-01-01T10:20:00Z"));
    const ids = (await state("x")).requests.map((q) => q.id);
    expect(ids).toContain(resume.id);
    expect(ids).toContain(recent.id);
    expect(ids).not.toContain(old.id);
  });
});

describe("dispatches", async () => {
  process.env.FACTORY_DISPATCH_TOKEN = "dispatch-token";
  const { POST: postDispatch } = await import("../dispatches/route");
  const { GET: getDispatches } = await import("./dispatches/route");
  const { POST: postDispatchDone } = await import("./dispatches/[id]/done/route");
  const body = { target: "react_frontend", source: "pip-audit", key: "requirements.txt", title: "vulnerable", details: "jinja2 3.1.2" };
  const dispatch = (b: unknown, token = "dispatch-token") => postDispatch(new Request("http://x/api/dispatches", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(b) }));
  const pending = (headers: Record<string, string> = auth) => getDispatches(new Request("http://x/api/factory/dispatches?target=react_frontend", { headers }));

  it("takes a dispatch with the dispatch token only, and the dispatch token reads nothing", async () => {
    expect((await dispatch(body, "secret-token")).status).toBe(401);
    expect((await pending({ authorization: "Bearer dispatch-token" })).status).toBe(401);
    const r = await dispatch(body);
    expect(r.status).toBe(202);
    expect(started).toEqual(["react_frontend"]); // the run starts at once, not on a schedule
    const { id } = (await r.json()) as { id: string };
    expect(((await (await pending()).json()) as { id: string }[]).map((s) => s.id)).toContain(id);
    await postDispatchDone(new Request("http://x", { method: "POST", headers: auth }), { params: Promise.resolve({ id }) });
    expect(((await (await pending()).json()) as { id: string }[]).map((s) => s.id)).not.toContain(id);
  });

  it("refuses an unknown target and a bad body", async () => {
    expect((await dispatch({ ...body, target: "nope" })).status).toBe(400);
    expect((await dispatch({ ...body, title: "" })).status).toBe(400);
  });
});
