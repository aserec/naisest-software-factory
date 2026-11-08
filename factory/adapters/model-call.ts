// One plain model call, over the provider's openai or anthropic API. Shared by the judge and the dashboard chat.
import { setTimeout as wait } from "node:timers/promises";

// What a call needs of a choice. Not seams.ts's ModelChoice (which any choice fits): importing that pulls every harness adapter into the dashboard's type check.
export interface ModelChoice { provider: { name: string; api: string; baseUrl?: string; keyEnv: string }; model: string }

// A 5xx, a lost connection or a timeout is the provider's passing trouble: up to RETRIES more tries, waiting retryMs, 2x, 3x between them.
const RETRIES = 3;

// The key and the base address of a choice, or an error. Apart from callModel so that the judge can fail when it is built.
export function checkModel({ provider }: ModelChoice, env: NodeJS.ProcessEnv): { key: string; base: string } {
  const key = env[provider.keyEnv];
  if (!key) throw new Error(`${provider.keyEnv} is not set`);
  // Only the provider's own baseUrl from seams.yml gets the key.
  if (!provider.baseUrl) throw new Error(`Provider ${provider.name} has no baseUrl`);
  return { key, base: provider.baseUrl.replace(/\/+$/, "") };
}

export async function callModel(
  choice: ModelChoice,
  env: NodeJS.ProcessEnv,
  system: string,
  messages: { role: "user" | "assistant"; content: string }[],
  { fetchFn = fetch, retryMs = 2000, maxTokens, timeoutMs = 60_000 }: { fetchFn?: typeof fetch; retryMs?: number; maxTokens?: number; timeoutMs?: number } = {},
): Promise<string> {
  const { key, base } = checkModel(choice, env);
  const { provider, model } = choice;
  const openai = provider.api === "openai";
  const call = () => fetchFn(openai ? `${base}/chat/completions` : `${base}/v1/messages`, {
    method: "POST",
    // Each try ends after timeoutMs, so a provider that never answers cannot leave the dashboard chat waiting forever.
    signal: AbortSignal.timeout(timeoutMs),
    headers: openai ? { Authorization: `Bearer ${key}`, "Content-Type": "application/json" } : { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify(
      openai
        // openai takes no max_tokens unless asked: the judge has always run without one.
        ? { model, temperature: 0, ...(maxTokens && { max_tokens: maxTokens }), messages: [{ role: "system", content: system }, ...messages] }
        : { model, max_tokens: maxTokens ?? 1024, temperature: 0, system, messages },
    ),
  });
  let res: Response | undefined;
  for (let attempt = 0; ; attempt++) {
    const last = attempt === RETRIES;
    try {
      res = await call();
    } catch (e) {
      if (last) throw e;
    }
    if ((res && res.status < 500) || last) break;
    await wait(retryMs * (attempt + 1));
  }
  if (!res) throw new Error("Model judge call failed: no response");
  // No body in the messages: it could echo the request.
  if (!res.ok) throw new Error(`Model judge call failed: HTTP ${res.status}`);
  const data = (await res.json().catch(() => {
    throw new Error("Model judge reply is not JSON");
  })) as any;
  const text: unknown = openai ? data.choices?.[0]?.message?.content : data.content?.map((b: { text?: string }) => b.text ?? "").join("");
  if (typeof text !== "string") throw new Error("Model judge reply has no text");
  return text;
}
