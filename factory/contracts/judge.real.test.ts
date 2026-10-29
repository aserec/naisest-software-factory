import { describe } from "vitest";
import { makeJevClient } from "../jev";
import { judgeContract } from "./judge.contract";

// Manual job only (contract-real in .gitlab-ci.yml): it calls the real Berget API and needs BERGET_API_KEY.
describe.skipIf(!process.env.FACTORY_CONTRACT_REAL)("real Berget judge", () => {
  judgeContract(() => makeJevClient(process.env));
});
