import { fakeJudge } from "../fakes";
import { judgeContract } from "./judge.contract";

judgeContract(() =>
  fakeJudge((q) => {
    if (q.kind === "noul") return { id: q.id, value: true, probability: 0.9, confidence: 0.8 };
    if (q.kind === "choice") return { id: q.id, value: q.options[0], probability: 0.7, confidence: 0.7 };
    return { id: q.id, value: q.min ?? 2, probability: 0.6, confidence: 0.6 };
  }),
);
