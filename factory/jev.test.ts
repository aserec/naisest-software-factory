import { afterEach, expect, test, vi } from "vitest";
import { makeJevClient, type JevQuestion } from "./jev";
import SAMPLE_RESPONSE from "./fixtures/systemone-response.json";

afterEach(() => vi.restoreAllMocks());

test("no BERGET_API_KEY gives the mock and says so", () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(makeJevClient({}).provider).toBe("mock");
  expect(log).toHaveBeenCalledWith(expect.stringContaining("Jev mock"));
});

test("berget client posts to /v1/systemone and never logs the key", async () => {
  const out = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
  const calls: [string, RequestInit][] = [];
  const fake = (async (url: string, init: RequestInit) => { calls.push([url, init]); return new Response(JSON.stringify(SAMPLE_RESPONSE)); }) as typeof fetch;
  const c = makeJevClient({ BERGET_API_KEY: "secret-key" }, fake);
  const qs: JevQuestion[] = [
    { id: "injection", kind: "noul", text: "?" },
    { id: "tone", kind: "choice", text: "?", options: ["angry", "calm", "excited"] },
    { id: "urgency", kind: "score", text: "?", levels: 3 },
  ];
  const answers = await c.ask({ title: "x" }, qs);
  expect(calls[0][0]).toMatch(/\/v1\/systemone$/);
  expect(answers).toEqual([
    { id: "injection", value: true, probability: 0.98, confidence: 0.98 },
    { id: "tone", value: "calm", probability: 0.8, confidence: 0.7 },
    { id: "urgency", value: 2, probability: 0.8, confidence: 0.55 },
  ]);
  expect(JSON.stringify(out.map((s) => s.mock.calls))).not.toContain("secret-key");
});

test("a failed Berget call throws and does not fall back to the mock", async () => {
  const fake = (async () => new Response("down", { status: 503 })) as typeof fetch;
  await expect(makeJevClient({ BERGET_API_KEY: "k" }, fake).ask({}, [])).rejects.toThrow(/503/);
});

test("the mock gives the same answers every time", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const qs: JevQuestion[] = [{ id: "a", kind: "noul", text: "?" }, { id: "b", kind: "choice", text: "?", options: ["x", "y"] }];
  const c = makeJevClient({});
  expect(await c.ask({}, qs)).toEqual(await c.ask({}, qs));
});
