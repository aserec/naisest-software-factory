import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import type { RunEvent } from "../seams";
import { makeHttpDashboard } from "./http-dashboard";

const event = (n: number): RunEvent => ({ id: randomUUID(), run: "r", at: new Date().toISOString(), target: "t", ticket: "1", type: "step_start", data: { n } });
const ok = () => new Response("{}");

// Review Focus 1: a dead dashboard never slows or fails a step.
test("with a fetch that never answers, send is instant, flush ends in 5 s and the queue keeps the newest 5000", async () => {
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

test("a refused batch (HTTP 400) is dropped, so it cannot block the events after it", async () => {
  const bodies: RunEvent[][] = [];
  let calls = 0;
  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    if (calls++ === 0) return new Response("{}", { status: 400 });
    bodies.push(JSON.parse(String(init?.body)));
    return ok();
  }) as unknown as typeof fetch;
  const dash = makeHttpDashboard("https://d.example", "tok", fetchFn);
  dash.send(event(1));
  await dash.flush();
  const next = event(2);
  dash.send(next);
  await dash.flush();
  expect(bodies.flat().map((e) => e.id)).toEqual([next.id]);
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
