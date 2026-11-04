import { randomUUID } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import type { RunEvent } from "../seams";
import { makeHttpDashboard } from "./http-dashboard";

const event = (n: number): RunEvent => ({ id: randomUUID(), run: "r", at: new Date().toISOString(), target: "t", ticket: "1", type: "step_start", data: { n } });
const ok = () => new Response("{}");
afterEach(() => vi.restoreAllMocks());

// Review Focus 1: a dead dashboard never slows or fails a step.
test("with a fetch that never answers, send is instant, flush ends in 5 s and the queue keeps the newest 5000", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  let hang = true;
  const bodies: RunEvent[][] = [];
  const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (hang) return new Promise<Response>(() => {});
    bodies.push(JSON.parse(String(init?.body)));
    return ok();
  }) as unknown as typeof fetch;
  const dash = makeHttpDashboard("https://d.example", "tok", fetchFn);
  const events = Array.from({ length: 10_000 }, (_, i) => event(i));
  let t = performance.now();
  for (const e of events) dash.send(e);
  expect(performance.now() - t).toBeLessThan(50);
  t = performance.now();
  await dash.flush();
  expect(performance.now() - t).toBeLessThan(5100);
  hang = false;
  await dash.flush();
  expect(bodies.every((b) => b.length <= 500)).toBe(true);
  expect(bodies.flat().map((e) => e.id)).toEqual(events.slice(5000).map((e) => e.id));
}, 15_000);

test("a batch that fails goes back to the front and is sent again in order", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const bodies: RunEvent[][] = [];
  let calls = 0;
  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    if (calls++ === 0) throw new Error("connection reset");
    bodies.push(JSON.parse(String(init?.body)));
    return ok();
  }) as unknown as typeof fetch;
  const dash = makeHttpDashboard("https://d.example/", "tok", fetchFn);
  const first = [event(1), event(2), event(3)];
  first.forEach((e) => dash.send(e));
  await dash.flush();
  const later = event(4);
  dash.send(later);
  await dash.flush();
  expect(bodies.flat().map((e) => e.id)).toEqual([...first, later].map((e) => e.id));
});

test("a 400 batch delivers the good events and drops only the bad one, with one warning that has no body", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const good: RunEvent[] = [event(1), event(3)];
  const bad: RunEvent = { ...event(2), type: "error", data: { message: "secret-in-body" } };
  const delivered: RunEvent[] = [];
  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    const events: RunEvent[] = JSON.parse(String(init?.body));
    if (events.some((e) => e.id === bad.id)) return new Response("{}", { status: 400 });
    delivered.push(...events);
    return ok();
  }) as unknown as typeof fetch;
  const dash = makeHttpDashboard("https://d.example", "tok", fetchFn);
  [good[0], bad, good[1]].forEach((e) => dash.send(e));
  await dash.flush();
  const next = event(4);
  dash.send(next);
  await dash.flush();
  expect(delivered.map((e) => e.id)).toEqual([...good, next].map((e) => e.id)); // the bad event is not retried
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0][0]).toBe(`dashboard: dropped error event ${bad.id}, the dashboard refused it`);
  warn.mockRestore();
});

test("another failing status or a network error warns once and the batch is kept", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  let calls = 0;
  const fetchFn = (async () => {
    if (calls++ < 2) return new Response("{}", { status: 503 });
    if (calls === 3) throw new Error("ECONNRESET");
    return ok();
  }) as unknown as typeof fetch;
  const dash = makeHttpDashboard("https://d.example", "tok", fetchFn);
  dash.send(event(1));
  for (let i = 0; i < 4; i++) await dash.flush();
  expect(warn.mock.calls.map((c) => c[0])).toEqual(["dashboard: HTTP 503", "dashboard: network error"]);
  expect(calls).toBe(4); // two 503s, one reset, then the same batch goes through
  warn.mockRestore();
});

test("every call carries the bearer token, and control and requestDone use the factory API paths", async () => {
  const seen: { url: string; method?: string; auth: string; body?: string }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    seen.push({ url, method: init?.method, auth: (init?.headers as Record<string, string>).authorization, body: init?.body as string | undefined });
    return new Response(JSON.stringify({ switches: {}, stop: false, requests: [] }));
  }) as unknown as typeof fetch;
  const dash = makeHttpDashboard("https://d.example", "tok", fetchFn);
  dash.send(event(1));
  await dash.flush();
  await dash.control("react_frontend", "42");
  await dash.requestDone("a/b", "refused");
  expect(seen.map((s) => [s.method ?? "GET", s.url, s.auth])).toEqual([
    ["POST", "https://d.example/api/events", "Bearer tok"],
    ["GET", "https://d.example/api/factory/control?target=react_frontend&run=42", "Bearer tok"],
    ["POST", "https://d.example/api/factory/requests/a%2Fb/done", "Bearer tok"],
  ]);
  expect(seen[2].body).toBe('{"outcome":"refused"}');
});

test("control throws when the dashboard cannot be reached or refuses", async () => {
  const down = makeHttpDashboard("https://d.example", "tok", (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch);
  await expect(down.control("t")).rejects.toThrow("ECONNREFUSED");
  const refused = makeHttpDashboard("https://d.example", "bad", (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch);
  await expect(refused.control("t")).rejects.toThrow("HTTP 401");
});

test("history repeats each type in the URL, returns the events, and throws on an error status or an unreachable dashboard", async () => {
  const seen: string[] = [];
  const events = [event(1), event(2)];
  const fetchFn = (async (url: string) => (seen.push(url), new Response(JSON.stringify(events)))) as unknown as typeof fetch;
  const dash = makeHttpDashboard("https://d.example", "tok", fetchFn);
  expect(await dash.history("react_frontend", "2026-01-01T00:00:00.000Z", ["run_start", "decision"])).toEqual(events);
  expect(seen).toEqual(["https://d.example/api/factory/history?target=react_frontend&since=2026-01-01T00%3A00%3A00.000Z&type=run_start&type=decision"]);
  const failing = makeHttpDashboard("https://d.example", "tok", (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch);
  await expect(failing.history("t", "2026-01-01", ["run_start"])).rejects.toThrow("HTTP 500");
  const down = makeHttpDashboard("https://d.example", "tok", (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch);
  await expect(down.history("t", "2026-01-01", ["run_start"])).rejects.toThrow("ECONNREFUSED");
});

test("with a slow dashboard, no new batch starts after flush returns", async () => {
  vi.useFakeTimers();
  try {
    let posts = 0;
    const fetchFn = (async () => {
      posts++;
      return new Promise<Response>((r) => setTimeout(() => r(ok()), 3000));
    }) as unknown as typeof fetch;
    const dash = makeHttpDashboard("https://d.example", "tok", fetchFn);
    for (let i = 0; i < 1200; i++) dash.send(event(i)); // four batches: the first send starts at 100 events
    const flushed = dash.flush();
    await vi.advanceTimersByTimeAsync(5000);
    await flushed;
    expect(posts).toBe(2); // the second batch is on its way when flush gives up
    await vi.advanceTimersByTimeAsync(20_000);
    expect(posts).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});
