import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOOKS_DIR, guardReady, runCommand } from "../agents";
import { piHome } from "../sandbox";
import { sandboxSettings } from "../steps/repo";
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

// The author's sandbox: the gate sandbox plus the provider's host. Pi reads and writes its own home, which is otherwise denied.
export function piSandboxSettings(cwd: string, home: string, provider: Provider) {
  const s = sandboxSettings(cwd, home);
  const host = provider.baseUrl ? new URL(provider.baseUrl).hostname : undefined;
  return {
    network: { ...s.network, allowedDomains: host ? [...s.network.allowedDomains, host] : s.network.allowedDomains },
    filesystem: { ...s.filesystem, allowRead: [home] },
  };
}

const EXTENSION = fileURLToPath(new URL("./pi-extension.ts", import.meta.url));
const quote = (a: string) => `'${a.replaceAll("'", `'\\''`)}'`;

// ponytail: event and field names below (session header, message_end, usage, stopReason, errorMessage) follow Pi's JSON mode docs.
// Confirm them on the runner's Pi version before the first real author run.
export function parsePiOutput(out: string) {
  let session = "", text = "", error = "", costUsd = 0;
  const tokens = { input: 0, output: 0 };
  for (const line of out.split("\n")) {
    let e: any;
    try { e = JSON.parse(line); } catch { continue; } // a cut or noisy line is skipped
    if (e.type === "session" && e.id) session = String(e.id);
    const m = e.type === "message_end" ? e.message : undefined;
    if (m?.role !== "assistant") continue;
    text = (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("") || text;
    tokens.input += Number(m.usage?.input ?? 0);
    tokens.output += Number(m.usage?.output ?? 0);
    costUsd += Number(m.usage?.cost?.total ?? 0);
    if (m.stopReason === "error" || m.errorMessage) error = String(m.errorMessage ?? "error");
  }
  return { session, text: text || error, error, limitHit: /\b429\b|rate.?limit|quota|usage limit/i.test(error), tokens, costUsd };
}

// Pi with tools, inside srt. The guard extension blocks dangerous bash calls; srt limits files and network.
async function runAuthor(job: HarnessJob): Promise<HarnessResult> {
  const home = piHome(job.cwd);
  const tmp = mkdtempSync(join(tmpdir(), "pi-srt-"));
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "models.json"), JSON.stringify(piModels(job.model)));
    const settings = join(tmp, "srt-settings.json"); // srt reads it once, before the command starts
    writeFileSync(settings, JSON.stringify(piSandboxSettings(job.cwd, home, job.model.provider)));
    const args = [
      "--print", "--mode", "json", "--no-extensions", "--extension", EXTENSION, "--no-skills", "--no-prompt-templates",
      "--no-context-files", "--no-mcp", "--provider", job.model.provider.name, "--model", job.model.model,
      // ponytail: --session <dir> --continue is from the plan. Confirm it on the runner's Pi (it may be --session-dir).
      ...(job.resume ? ["--session", home, "--continue"] : []), "--", job.prompt,
    ];
    const { code, out } = await runCommand("srt", ["--settings", settings, "-c", ["pi", ...args].map(quote).join(" ")], agentEnv(process.env, job.model.provider, home), job.cwd);
    const r = parsePiOutput(out);
    // stopped stays false until Task 8.
    return { session: r.session, ok: code === 0 && !r.error, limitHit: r.limitHit, stopped: false, costUsd: r.costUsd, tokens: r.tokens, text: r.text };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export const pi: Harness = {
  apis: ["anthropic", "openai"],
  async run(job: HarnessJob): Promise<HarnessResult> {
    guardReady(HOOKS_DIR); // fail closed: never start without the command guard
    if (job.tools === "code") return runAuthor(job);
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
