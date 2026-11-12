import { randomUUID } from "node:crypto";
import type { ControlRequest, ControlState, RunEvent } from "software-factory/run-events";
import { afterEach, describe, expect, it, vi } from "vitest";

// The dispatch route starts a run through the CI: the test keeps the targets it was asked to start.
const started = vi.hoisted(() => [] as string[]);
vi.mock("@/server/compose", () => ({ getCi: () => ({ startDispatch: async (target: string) => void started.push(target) }) }));
// after() needs a live request; here it keeps the work, and the test runs it once the answer is back.
const afterAnswer = vi.hoisted(() => [] as (() => unknown)[]);
vi.mock("next/server", async (real) => ({ ...(await real<typeof import("next/server")>()), after: (fn: () => unknown) => void afterAnswer.push(fn) }));

process.env.DASHBOARD_DB = ":memory:";
process.env.FACTORY_DASHBOARD_TOKEN = "secret-token";

const { getDb } = await import("@/server/db-instance");
const { POST: postEvents } = await import("../events/route");
const { GET: getControl } = await import("./control/route");
const { POST: postDone } = await import("./requests/[id]/done/route");
const { factoryStatus } = await import("@/server/factory-status");

const auth = { authorization: "Bearer secret-token" };
const ev = (type: RunEvent["type"], data: Record<string, unknown>, run = "r1"): RunEvent => ({ id: randomUUID(), run, at: new Date().toISOString(), target: "t", ticket: "T-1", type, data }) as RunEvent;
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

  it("counts each call as the factory's heartbeat, so a target quiet for 5 minutes shows as down", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-12T07:00:00Z"), toFake: ["Date"] });
    await control("r1");
    const status = (now: string) => factoryStatus(["t", "other"], getDb().factoriesSeen(), new Date(now)).map((s) => s.down);
    expect(status("2026-11-12T07:04:59Z")).toEqual([false, true]);
    expect(status("2026-11-12T07:05:01Z")).toEqual([true, true]);
  });

  it("sets stop for the run with a pending stop only", async () => {
    getDb().addEvents([ev("run_start", {}, "ra"), ev("label_change", { to: "running" }, "ra")]);
    ask("stop", "ra");
    expect((await state("ra")).stop).toBe(true);
    expect((await state("rb")).stop).toBe(false);
    // local-factory.sh's poller finishes a stop no pipeline cancel reached, so the stop is in requests too.
    expect((await state("rb")).requests.map((q) => q.run)).toContain("ra");
  });

  it("returns a cancelled stop in requests without stop", async () => {
    getDb().addEvents([ev("run_start", {}, "rc"), ev("label_change", { to: "running" }, "rc")]);
    const r = ask("stop", "rc");
    await done(r.id, "cancelled");
    const s = await state("rc");
    expect(s.stop).toBe(false);
    expect(s.requests.map((q) => q.id)).toContain(r.id);
  });

  it("returns a pending resume and keeps a restart for 15 minutes after it is done", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T10:00:00Z"));
    const stopped = (run: string) => getDb().addEvents([ev("label_change", { to: "stopped" }, run)]);
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
    expect(started).toEqual([]); // the answer does not wait for the CI
    await Promise.all(afterAnswer.splice(0).map((fn) => fn()));
    expect(started).toEqual(["react_frontend"]); // the run starts at once, not on a schedule
    const { id } = (await r.json()) as { id: string };
    expect(((await (await pending()).json()) as { id: string }[]).map((s) => s.id)).toContain(id);
    await postDispatchDone(new Request("http://x", { method: "POST", headers: auth }), { params: Promise.resolve({ id }) });
    expect(((await (await pending()).json()) as { id: string }[]).map((s) => s.id)).not.toContain(id);
  });

  it("done keeps the work item's url, but only an http(s) one", async () => {
    const markDone = (id: string, workItem: string) => postDispatchDone(new Request("http://x", { method: "POST", headers: auth, body: JSON.stringify({ workItem }) }), { params: Promise.resolve({ id }) });
    const a = getDb().addDispatch(body);
    const b = getDb().addDispatch(body);
    await markDone(a.id, "https://gl/issues/7");
    await markDone(b.id, "javascript:alert(1)");
    const log = getDb().dispatchLog("react_frontend", 50);
    expect(log.find((d) => d.id === a.id)?.workItem).toBe("https://gl/issues/7");
    expect(log.find((d) => d.id === b.id)).toMatchObject({ id: b.id, doneAt: expect.any(String) });
    expect(log.find((d) => d.id === b.id)?.workItem).toBeUndefined();
  });

  it("refuses an unknown target and a bad body", async () => {
    expect((await dispatch({ ...body, target: "nope" })).status).toBe(400);
    expect((await dispatch({ ...body, title: "" })).status).toBe(400);
  });
});

describe("history", async () => {
  const { GET: getHistory } = await import("./history/route");
  const at = (h: number) => new Date(Date.UTC(2026, 5, 1, h)).toISOString();
  const get = (query: string, headers: Record<string, string> = auth) => getHistory(new Request(`http://x/api/factory/history?${query}`, { headers }));
  const since = encodeURIComponent(at(2));

  it("needs the factory token, a target, a date and known types", async () => {
    expect((await get(`target=h&since=${since}`, {})).status).toBe(401);
    expect((await get(`since=${since}`)).status).toBe(400);
    expect((await get("target=h&since=yesterday")).status).toBe(400);
    expect((await get("target=h")).status).toBe(400);
    expect((await get(`target=h&since=${since}&type=nope`)).status).toBe(400);
    expect((await get(`target=h&since=${since}`)).status).toBe(400);
  });

  it("returns only the asked target, types and times, oldest first", async () => {
    const mk = (type: RunEvent["type"], h: number, target = "h"): RunEvent => ({ ...ev(type, {}), target, at: at(h) });
    const [a, b, c] = [mk("decision", 3), mk("run_start", 2), mk("decision", 4)];
    getDb().addEvents([mk("run_start", 1), a, b, c, mk("usage", 3), mk("decision", 3, "other")]);
    const r = await get(`target=h&since=${since}&type=decision&type=run_start`);
    expect(r.status).toBe(200);
    expect(((await r.json()) as RunEvent[]).map((e) => e.id)).toEqual([a.id, b.id, c.id]);
  });
});

describe("plans", async () => {
  const { GET: getPlans } = await import("./plans/route");
  const { POST: postPlan } = await import("./plans/[id]/route");
  const list = (headers: Record<string, string> = auth) => getPlans(new Request("http://x/api/factory/plans", { headers }));
  const move = (id: string, body: unknown, headers: Record<string, string> = auth) => postPlan(new Request("http://x", { method: "POST", headers, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
  const approved = () => {
    const id = getDb().addChatMessage({ path: "/p", author: "agent", text: "plan", plan: { repo: "target", summary: "fix it", steps: ["one"] }, planUser: "ann" }).plan!.id;
    getDb().approvePlan(id, "ann");
    return id;
  };

  it("refuses a call without the token", async () => {
    expect((await list({})).status).toBe(401);
    expect((await move("x", { state: "running" }, {})).status).toBe(401);
  });

  it("lists the approved plans, and a second claim gets 409", async () => {
    const id = approved();
    expect(((await (await list()).json()) as { id: string }[]).map((p) => p.id)).toContain(id);
    expect((await move(id, { state: "running" })).status).toBe(200);
    expect((await move(id, { state: "running" })).status).toBe(409);
    expect((await move(id, { state: "done", result: "https://pr" })).status).toBe(200);
  });

  it("refuses a state the worker may not set and a long result", async () => {
    const id = approved();
    expect((await move(id, { state: "approved" })).status).toBe(400);
    expect((await move(id, { state: "done", result: "r".repeat(2001) })).status).toBe(400);
  });
});
