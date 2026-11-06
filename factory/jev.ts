// Jev client: Celeris serves the TypeSafe Jev /v1/systemone API.
// Without the host's key it refuses to start. A failed call throws.

export type JevQuestion =
  | { id: string; kind: "noul"; text: string }
  | { id: string; kind: "choice"; text: string; options: string[] }
  | { id: string; kind: "score"; text: string; levels: number; min?: number };
export interface JevAnswer { id: string; value: string | number | boolean; probability: number; confidence: number }
export interface JevClient { readonly provider: "celeris" | "mock" | "model"; ask(state: unknown, questions: JevQuestion[]): Promise<JevAnswer[]> }

// Fixed, never from an env variable: trigger callers can set any variable, and the key goes to this host.
// docs.celeris.ai/models.md: the URL keeps celeris-1-decision, the body names celeris-1.1-decision.
export const JEV_HOST = { url: "https://inference.celeris.ai/celeris-1-decision/v1/systemone", model: "celeris-1.1-decision", keyEnv: "CELERIS_API_KEY" } as const;

export type ApiAnswer = {
  type: "noul" | "choice" | "score";
  noul?: number;
  choice?: string;
  score?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
};

function toApiQuestion(q: JevQuestion) {
  if (q.kind === "noul") return { type: "noul", instructions: q.text };
  if (q.kind === "choice") return { type: "choice", instructions: q.text, criteria: Object.fromEntries(q.options.map((o) => [o, null])) };
  return { type: "score", instructions: q.text, criteria: Array.from({ length: q.levels }, (_, i) => `Score ${(q.min ?? 2) + i}`) };
}

export function fromApiAnswer(q: JevQuestion, a: ApiAnswer | undefined): JevAnswer {
  if (!a || a.type !== q.kind) throw new Error(`Jev answer missing or wrong type for "${q.id}"`);
  if (q.kind === "noul") {
    const p = a.noul;
    if (typeof p !== "number") throw new Error(`Jev noul answer for "${q.id}" has no probability`);
    return { id: q.id, value: p >= 0.5, probability: p, confidence: a.confidence ?? p };
  }
  const probs = a.probabilities ?? {};
  const [best, p] = Object.entries(probs).sort((x, y) => y[1] - x[1])[0] ?? [];
  if (best === undefined) throw new Error(`Jev answer for "${q.id}" has no probabilities`);
  // An answer outside the question fails closed: the caller blocks instead of guessing.
  if (q.kind === "choice" && !q.options.includes(best)) throw new Error(`Jev answer for "${q.id}" is not one of the options: ${JSON.stringify(best)}`);
  if (q.kind === "score" && !(Number.isInteger(Number(best)) && Number(best) >= 0 && Number(best) < q.levels)) throw new Error(`Jev score answer for "${q.id}" is not a number in the question range: ${JSON.stringify(best)}`);
  const value = q.kind === "choice" ? best : (q.min ?? 2) + Number(best);
  return { id: q.id, value, probability: p, confidence: a.confidence ?? p };
}

export function makeJevClient(env: NodeJS.ProcessEnv, fetchFn: typeof fetch = fetch): JevClient {
  const host = JEV_HOST;
  const key = env[host.keyEnv];
  // No silent stand-in: a judge with fixed answers would build or close tickets on answers nobody gave.
  if (!key) throw new Error(`${host.keyEnv} is not set. seams.yml picks judge jev-celeris, which needs it.`);
  return {
    provider: "celeris",
    async ask(state, questions) {
      const res = await fetchFn(host.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: host.model,
          state,
          questions: Object.fromEntries(questions.map((q) => [q.id, toApiQuestion(q)])),
        }),
      });
      if (!res.ok) throw new Error(`Celeris Jev call failed: HTTP ${res.status}`);
      const body = (await res.json()) as { answers: Record<string, ApiAnswer> };
      return questions.map((q) => fromApiAnswer(q, body.answers?.[q.id]));
    },
  };
}
