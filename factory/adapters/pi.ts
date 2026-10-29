import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOKS_DIR, guardReady, runCommand } from "../agents";
import type { Harness, HarnessJob, HarnessResult, ModelChoice, Provider } from "../seams";

// Pi config for one job: the job's provider is the only provider. Tools are turned off by flags in piArgs.
export function piModels({ provider, model }: ModelChoice) {
  return {
    providers: {
      [provider.name]: { name: provider.name, baseUrl: provider.baseUrl, api: provider.api === "openai" ? "openai-completions" : "anthropic-messages", apiKey: `$${provider.keyEnv}`, models: [{ id: model }] },
    },
  };
}

// No tools (the diff is in the prompt), no session file, and nothing loaded from the cwd or the agent dir.
export const piArgs = (provider: string, model: string, prompt: string) => [
  "--print", "--no-tools", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates",
  "--no-context-files", "--no-mcp", "--no-approve", "--offline", "--provider", provider, "--model", model, "--", prompt,
];

// Nothing secret except the provider key, which Pi reads through models.json. No Claude token, no GitLab token.
export function agentEnv(env: NodeJS.ProcessEnv, provider: Provider, dir: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { PATH: env.PATH, HOME: dir, PI_CODING_AGENT_DIR: dir, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", [provider.keyEnv]: env[provider.keyEnv] };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

export const pi: Harness = {
  apis: ["anthropic", "openai"],
  async run(job: HarnessJob): Promise<HarnessResult> {
    guardReady(HOOKS_DIR); // fail closed: never start without the command guard
    if (job.tools === "code") throw new Error("Pi author needs the sandbox"); // Task 7
    // Pi runs in an empty temp dir, so no project config or plugin from the target clone loads. job.cwd is not used.
    // The dir is also Pi's agent dir, so no auth.json, settings or extensions from the runner's home load.
    const dir = mkdtempSync(join(tmpdir(), "pi-"));
    try {
      writeFileSync(join(dir, "models.json"), JSON.stringify(piModels(job.model)));
      const { code, out } = await runCommand("pi", piArgs(job.model.provider.name, job.model.model, job.prompt), agentEnv(process.env, job.model.provider, dir), dir);
      // Pi has no session to resume and reports no cost, so those stay empty. stopped stays false until Task 8.
      return { session: "", ok: code === 0, limitHit: false, stopped: false, costUsd: 0, tokens: { input: 0, output: 0 }, text: out };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};
