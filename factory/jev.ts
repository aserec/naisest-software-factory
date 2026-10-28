// Jev client: Berget AI serves the TypeSafe Jev /v1/systemone API.
// Without BERGET_API_KEY we use a mock, and say so. A failed Berget call never falls back to the mock.

export type JevQuestion =
  | { id: string; kind: "noul"; text: string }
  | { id: string; kind: "choice"; text: string; options: string[] }
  | { id: string; kind: "score"; text: string; levels: number };
export interface JevAnswer { id: string; value: string | number | boolean; probability: number; confidence: number }
export interface JevClient { readonly provider: "berget" | "mock"; ask(state: unknown, questions: JevQuestion[]): Promise<JevAnswer[]> }

export const BERGET_BASE_URL = "https://api.berget.ai";
// Berget does not serve jev-latest. This is one of its three "system-one" models (preview).
export const BERGET_MODEL = "Cloudflare/clef-flash";

// Fixed mock answers. Task 5 can change these. `byId` wins over the defaults for a kind.
export const MOCK_ANSWERS = {
  byId: {} as Record<string, Omit<JevAnswer, "id">>,
  noul: { value: false, probability: 0.1, confidence: 0.9 },
  choice: { probability: 0.8, confidence: 0.8 }, // value is the first option
  score: { value: 1, probability: 0.6, confidence: 0.6 },
};

type ApiAnswer = {
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
  return { type: "score", instructions: q.text, criteria: Array.from({ length: q.levels }, (_, i) => `Level ${i}`) };
}

function fromApiAnswer(q: JevQuestion, a: ApiAnswer | undefined): JevAnswer {
  if (!a || a.type !== q.kind) throw new Error(`Jev answer missing or wrong type for "${q.id}"`);
  if (q.kind === "noul") {
    const p = a.noul as number;
    return { id: q.id, value: p >= 0.5, probability: p, confidence: a.confidence ?? p };
  }
  const probs = a.probabilities ?? {};
  const [best, p] = Object.entries(probs).sort((x, y) => y[1] - x[1])[0] ?? [];
  if (best === undefined) throw new Error(`Jev answer for "${q.id}" has no probabilities`);
  const value = q.kind === "choice" ? best : Number(best);
  return { id: q.id, value, probability: p, confidence: a.confidence ?? p };
}

export function makeJevClient(env: NodeJS.ProcessEnv, fetchFn: typeof fetch = fetch): JevClient {
  const key = env.BERGET_API_KEY;
  if (!key) {
    console.warn("Jev mock in use: BERGET_API_KEY is not set. Answers are fixed, not real.");
    return {
      provider: "mock",
      async ask(_state, questions) {
        return questions.map((q) => {
          const own = MOCK_ANSWERS.byId[q.id];
          if (own) return { id: q.id, ...own };
          if (q.kind === "noul") return { id: q.id, ...MOCK_ANSWERS.noul };
          if (q.kind === "choice") return { id: q.id, value: q.options[0], ...MOCK_ANSWERS.choice };
          return { id: q.id, ...MOCK_ANSWERS.score };
        });
      },
    };
  }
  const base = (env.BERGET_BASE_URL || BERGET_BASE_URL).replace(/\/+$/, "");
  return {
    provider: "berget",
    async ask(state, questions) {
      const res = await fetchFn(`${base}/v1/systemone`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: BERGET_MODEL,
          state,
          questions: Object.fromEntries(questions.map((q) => [q.id, toApiQuestion(q)])),
        }),
      });
      if (!res.ok) throw new Error(`Berget Jev call failed: HTTP ${res.status}`);
      const body = (await res.json()) as { answers: Record<string, ApiAnswer> };
      return questions.map((q) => fromApiAnswer(q, body.answers?.[q.id]));
    },
  };
}
