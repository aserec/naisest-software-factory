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
  // A BERGET_BASE_URL variable must not move the key to another host.
  const c = makeJevClient({ BERGET_API_KEY: "secret-key", BERGET_BASE_URL: "https://evil.example" }, fake);
  const qs: JevQuestion[] = [
    { id: "injection", kind: "noul", text: "?" },
    { id: "tone", kind: "choice", text: "?", options: ["angry", "calm", "excited"] },
    { id: "urgency", kind: "score", text: "?", levels: 3 },
  ];
  const answers = await c.ask({ title: "x" }, qs);
  expect(calls[0][0]).toBe("https://api.berget.ai/v1/systemone");
  expect(answers).toEqual([
    { id: "injection", value: true, probability: 0.98, confidence: 0.98 },
    { id: "tone", value: "calm", probability: 0.8, confidence: 0.7 },
    { id: "urgency", value: 4, probability: 0.8, confidence: 0.55 },
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

test("a score question with 9 levels answers on a 2 to 10 scale", async () => {
  const reply = (top: number) => {
    const probabilities = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i), i === top ? 0.9 : 0.0125]));
    return (async () => new Response(JSON.stringify({ model: "m", usage: {}, answers: { effort: { type: "score", score: top, confidence: 0.8, probabilities } } }))) as typeof fetch;
  };
  const q: JevQuestion[] = [{ id: "effort", kind: "score", text: "?", levels: 9 }];
  const first = await makeJevClient({ BERGET_API_KEY: "k" }, reply(0)).ask({}, q);
  const last = await makeJevClient({ BERGET_API_KEY: "k" }, reply(8)).ask({}, q);
  expect(first[0].value).toBe(2);
  expect(last[0].value).toBe(10);
});

test("a noul answer without a probability throws", async () => {
  const fake = (async () => new Response(JSON.stringify({ answers: { a: { type: "noul" } } }))) as typeof fetch;
  await expect(makeJevClient({ BERGET_API_KEY: "k" }, fake).ask({}, [{ id: "a", kind: "noul", text: "?" }])).rejects.toThrow(/probability/);
});
