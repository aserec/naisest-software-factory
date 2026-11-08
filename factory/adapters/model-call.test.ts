import { expect, test } from "vitest";
import type { ModelChoice } from "../seams";
import { callModel } from "./model-call";

const openai: ModelChoice = { provider: { name: "tensorx", api: "openai", baseUrl: "https://t.example/v1/", keyEnv: "T_KEY", models: { m: "other" } }, model: "m" };
const anthropic: ModelChoice = { provider: { name: "gw", api: "anthropic", baseUrl: "https://gw.example", keyEnv: "G_KEY", models: { m: "claude" } }, model: "m" };
const env = { T_KEY: "secret-t", G_KEY: "secret-g" };
const msgs = [{ role: "user" as const, content: "hi" }];

// A fake fetch: records the calls and answers with `body` and `status`.
function fake(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(status === 200 ? JSON.stringify(body) : "key secret-t leaked", { status }); }) as typeof fetch;
  return { fn, calls };
}

test("openai: posts to /chat/completions with the bearer key, the system as first message", async () => {
  const f = fake({ choices: [{ message: { content: "hello" } }] });
  expect(await callModel(openai, env, "SYS", msgs, { fetchFn: f.fn })).toBe("hello");
  expect(f.calls[0].url).toBe("https://t.example/v1/chat/completions");
  expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer secret-t");
  expect(JSON.parse(f.calls[0].init.body as string)).toEqual({ model: "m", temperature: 0, messages: [{ role: "system", content: "SYS" }, ...msgs] });
});

test("anthropic: posts to /v1/messages with x-api-key, max_tokens 1024 unless given", async () => {
  const f = fake({ content: [{ type: "text", text: "he" }, { type: "text", text: "llo" }] });
  expect(await callModel(anthropic, env, "SYS", msgs, { fetchFn: f.fn })).toBe("hello");
  expect(f.calls[0].url).toBe("https://gw.example/v1/messages");
  expect((f.calls[0].init.headers as Record<string, string>)["x-api-key"]).toBe("secret-g");
  expect(JSON.parse(f.calls[0].init.body as string)).toEqual({ model: "m", max_tokens: 1024, temperature: 0, system: "SYS", messages: msgs });
  await callModel(anthropic, env, "SYS", msgs, { fetchFn: f.fn, maxTokens: 50 });
  expect(JSON.parse(f.calls[1].init.body as string).max_tokens).toBe(50);
});

test("a 5xx is tried again 3 more times, then throws with the status and no body; a 4xx is not tried again", async () => {
  const down = fake({}, 504);
  await expect(callModel(openai, env, "S", msgs, { fetchFn: down.fn, retryMs: 0 })).rejects.toThrow("HTTP 504");
  expect(down.calls).toHaveLength(4);
  const bad = fake({}, 401);
  const err = await callModel(openai, env, "S", msgs, { fetchFn: bad.fn, retryMs: 0 }).catch((e: Error) => e);
  expect((err as Error).message).toBe("Model judge call failed: HTTP 401");
  expect(bad.calls).toHaveLength(1);
});

test("a provider that never answers times out, counts as a failed try, and throws after the last", async () => {
  let calls = 0;
  const hang = ((_url: string, init: RequestInit) => {
    calls++;
    return new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)));
  }) as typeof fetch;
  await expect(callModel(openai, env, "S", msgs, { fetchFn: hang, retryMs: 0, timeoutMs: 20 })).rejects.toThrow(/timeout|aborted/i);
  expect(calls).toBe(4);
});

test("a missing key or baseUrl throws", async () => {
  await expect(callModel(openai, {}, "S", msgs)).rejects.toThrow("T_KEY is not set");
  await expect(callModel({ ...openai, provider: { ...openai.provider, baseUrl: undefined } }, env, "S", msgs)).rejects.toThrow(/baseUrl/);
});
