import { describe } from "vitest";
import { makeModelJudge } from "../adapters/model-judge";
import { loadSeams, modelChoice } from "../config";
import { makeJevClient } from "../jev";
import { judgeContract } from "./judge.contract";

// Manual job only (contract-real in .gitlab-ci.yml): it calls the real Celeris API and needs CELERIS_API_KEY.
describe.skipIf(!process.env.FACTORY_CONTRACT_REAL)("real Celeris judge", () => {
  judgeContract(() => makeJevClient(process.env));
});

// Uses the provider and model of seams.yml judgeModel, and needs that provider's key.
describe.skipIf(!process.env.FACTORY_CONTRACT_REAL)("real model-call judge", () => {
  const seams = loadSeams();
  judgeContract(() => makeModelJudge(modelChoice(seams.judgeModel, seams), process.env));
});
