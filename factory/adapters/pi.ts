import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOOKS_DIR, guardReady, runCommand } from "../agents";
import { pumpInbox } from "../inbox";
import { SRT, piHome } from "../sandbox";
import { sandboxSettings } from "../steps/repo";
import type { Harness, HarnessJob, HarnessResult, ModelChoice, Provider } from "../seams";

// Pi config for one job: the job's provider is the only provider. Tools are turned off by flags in piArgs.
export function piModels({ provider, model }: ModelChoice) {
  return {
    providers: {
      [provider.name]: { name: provider.name, baseUrl: provider.baseUrl, api: provider.api === "openai" ? "openai-completions" : "anthropic-messages", apiKey: `$${provider.keyEnv}`, models: [{ id: model, ...(provider.images?.includes(model) && { input: ["text", "image"] }) }] },
    },
  };
}

// No tools (the diff is in the prompt), no session file, and nothing loaded from the cwd or the agent dir.
export const piArgs = (provider: string, model: string, prompt: string, files: string[] = []) => [
  "--print", "--no-tools", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates",
  "--no-context-files", "--no-mcp", "--no-approve", "--offline", "--provider", provider, "--model", model, "--", ...files.map((f) => "@" + f), prompt,
];

// Nothing secret except the provider key, which Pi reads through models.json. No Claude token, no GitLab token.
export function agentEnv(env: NodeJS.ProcessEnv, provider: Provider, dir: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { PATH: env.PATH, HOME: dir, PI_CODING_AGENT_DIR: dir, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", [provider.keyEnv]: env[provider.keyEnv], pnpm_config_store_dir: env.FACTORY_PNPM_STORE, PLAYWRIGHT_BROWSERS_PATH: env.PLAYWRIGHT_BROWSERS_PATH };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

// The author's sandbox: the gate sandbox plus the provider's host. Pi reads and writes its own home, which is otherwise denied.
export function piSandboxSettings(cwd: string, home: string, provider: Provider, preview = false) {
  const s = sandboxSettings(cwd, home, process.env.FACTORY_PNPM_STORE); // set on local runs only
  const host = provider.baseUrl ? new URL(provider.baseUrl).hostname : undefined;
  return {
    network: { ...s.network, allowedDomains: host ? [...s.network.allowedDomains, host] : s.network.allowedDomains, ...(preview && { allowLocalBinding: true }) }, // preview: the author starts the target's dev server
    filesystem: { ...s.filesystem, allowRead: [home] },
  };
}

const EXTENSION = fileURLToPath(new URL("./pi-extension.ts", import.meta.url));
const quote = (a: string) => `'${a.replaceAll("'", `'\\''`)}'`;
// Pi or srt can fail before Pi writes a message. The exit code and stderr then hold the only reason.
const exitText = (code: number | null, err: string) => `Pi exited with code ${code}. The end of its error output:\n${err.trim() || "(empty)"}`;

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
    // Pi retries a failed request, so only the last assistant message tells how the run ended.
    error = m.stopReason === "error" || m.errorMessage ? String(m.errorMessage ?? "error") : "";
  }
  return { session, text: text || error, error, limitHit: /\b429\b|rate.?limit|quota|usage limit/i.test(error), tokens, costUsd };
}

// Pi with tools, inside srt. The guard extension blocks dangerous bash calls; srt limits files and network.
async function runAuthor(job: HarnessJob): Promise<HarnessResult> {
  const home = piHome(job.cwd);
  const tmp = mkdtempSync(join(tmpdir(), "pi-srt-"));
  let pump: ReturnType<typeof pumpInbox> | undefined;
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "models.json"), JSON.stringify(piModels(job.model)));
    const settings = join(tmp, "srt-settings.json"); // srt reads it once, before the command starts
    writeFileSync(settings, JSON.stringify(piSandboxSettings(job.cwd, home, job.model.provider, job.preview)));
    const args = [
      "--print", "--mode", "json", "--no-extensions", "--extension", EXTENSION, "--no-skills", "--no-prompt-templates",
      "--no-context-files", "--no-mcp", "--provider", job.model.provider.name, "--model", job.model.model,
      // ponytail: --session <dir> --continue is from the plan. Confirm it on the runner's Pi (it may be --session-dir).
      ...(job.resume ? ["--session", home, "--continue"] : []), "--", job.prompt,
    ];
    // The extension reads the inbox file from Pi's home (the one place inside the sandbox that Pi may read). A new run starts with a new inbox.
    const inboxFile = join(home, "inbox.jsonl");
    rmSync(inboxFile, { force: true });
    rmSync(`${inboxFile}.read`, { force: true });
    if (job.inbox) pump = pumpInbox(job.inbox, inboxFile);
    const { code, out, err } = await runCommand(SRT, ["--settings", settings, "-c", ["pi", ...args].map(quote).join(" ")], agentEnv(process.env, job.model.provider, home), job.cwd);
    const stopped = (await pump?.end()) ?? false; // the extension aborts the agent at its next tool result after a stop line
    pump = undefined;
    const r = parsePiOutput(out);
    return { session: r.session, ok: code === 0 && !r.error && !stopped, limitHit: r.limitHit, stopped, costUsd: r.costUsd, tokens: r.tokens, text: r.error || code === 0 ? r.text : exitText(code, err) };
  } finally {
    await pump?.end(); // only still set when the run threw
    rmSync(tmp, { recursive: true, force: true });
  }
}

export const pi: Harness = {
  apis: ["anthropic", "openai"],
  images: true,
  async run(job: HarnessJob): Promise<HarnessResult> {
    guardReady(HOOKS_DIR); // fail closed: never start without the command guard
    if (job.tools === "code") return runAuthor(job);
    // Pi runs in an empty temp dir, so no project config or plugin from the target clone loads. job.cwd is not used.
    // The dir is also Pi's agent dir, so no auth.json, settings or extensions from the runner's home load.
    const dir = mkdtempSync(join(tmpdir(), "pi-"));
    try {
      writeFileSync(join(dir, "models.json"), JSON.stringify(piModels(job.model)));
      const files = (job.images ?? []).map((i) => { const f = join(dir, i.name); writeFileSync(f, i.data); return f; });
      const { code, out, err } = await runCommand("pi", piArgs(job.model.provider.name, job.model.model, job.prompt, files), agentEnv(process.env, job.model.provider, dir), dir);
      // Pi has no session to resume and reports no cost, so those stay empty. It has no tools, so the inbox is not used and it is never stopped.
      return { session: "", ok: code === 0, limitHit: false, stopped: false, costUsd: 0, tokens: { input: 0, output: 0 }, text: code === 0 ? out : exitText(code, err) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};
