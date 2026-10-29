import { describe } from "vitest";
import { claudeCode } from "../adapters/claude-code";
import { pi } from "../adapters/pi";
import type { Provider } from "../seams";
import { harnessContract } from "./harness.contract";

// Manual job only (contract-real in .gitlab-ci.yml): it makes real model calls.
// Claude Code needs CLAUDE_CODE_OAUTH_TOKEN. Pi needs TENSORX_API_KEY and CONTRACT_PI_MODEL (a model TensorX serves).
const teamPlan: Provider = { name: "team-plan", api: "anthropic", keyEnv: "CLAUDE_CODE_OAUTH_TOKEN", models: { "claude-sonnet-5-5": "claude" } };
const tensorx: Provider = { name: "tensorx", api: "openai", baseUrl: "https://api.tensorx.ai/v1", keyEnv: "TENSORX_API_KEY", models: {} };

describe.skipIf(!process.env.FACTORY_CONTRACT_REAL)("real Claude Code harness", () => {
  harnessContract(() => claudeCode, { model: { provider: teamPlan, model: "claude-sonnet-5-5", effort: "medium" }, unserved: { provider: teamPlan, model: "no-such-model" } });
});

describe.skipIf(!process.env.FACTORY_CONTRACT_REAL)("real Pi harness", () => {
  harnessContract(() => pi, { model: { provider: tensorx, model: process.env.CONTRACT_PI_MODEL ?? "" }, unserved: { provider: tensorx, model: "no-such-model" }, author: false });
});
