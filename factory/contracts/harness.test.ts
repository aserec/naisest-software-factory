import { fakeHarness } from "../fakes";
import type { Provider } from "../seams";
import { harnessContract } from "./harness.contract";

const provider: Provider = { name: "fake", api: "anthropic", keyEnv: "FAKE_KEY", models: { served: "claude" } };

harnessContract(
  () => fakeHarness((job) => (job.model.model === "served" ? { text: "pong", toolCalls: [{ name: "Bash", input: "{}", result: "pong", ms: 5, ok: true }] } : { ok: false })),
  { model: { provider, model: "served" }, unserved: { provider, model: "not-served" } },
);
