import { makeModelJudge } from "../adapters/model-judge";
import { fakeJudge } from "../fakes";
import { judgeContract } from "./judge.contract";

judgeContract(() =>
  fakeJudge((q) => {
    if (q.kind === "noul") return { id: q.id, value: true, probability: 0.9, confidence: 0.8 };
    if (q.kind === "choice") return { id: q.id, value: q.options[0], probability: 0.7, confidence: 0.7 };
    return { id: q.id, value: q.min ?? 2, probability: 0.6, confidence: 0.6 };
  }),
);

// The model-call judge, with a fake fetch that answers every contract question.
const reply = { a: { value: 0.9, confidence: 0.8 }, b: { value: "red", confidence: 0.7 }, c: { value: 3, confidence: 0.6 } };
const fakeFetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answers: reply }) } }] }))) as typeof fetch;
const choice = { provider: { name: "p", api: "openai" as const, baseUrl: "https://p.example/v1", keyEnv: "P_KEY", models: { m: "x" } }, model: "m" };
judgeContract(() => makeModelJudge(choice, { P_KEY: "k" }, fakeFetch));
