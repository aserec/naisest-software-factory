import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOOKS_DIR, TSX_IMPORT, guardReady, runCommand } from "../agents";
import { pumpInbox } from "../inbox";
import { SANDBOX_RULES_PATH, sandboxDenyRead } from "../sandbox";
import { HARNESS_HOMES, type Harness, type HarnessJob, type HarnessResult, type Provider, type ToolCall } from "../seams";

export interface ClaudeRun { prompt: string; model: string; effort: "medium" | "high"; maxTurns: number; cwd: string; resumeSessionId?: string; images?: boolean }
export interface ClaudeResult { sessionId: string; isError: boolean; limitHit: boolean; costUsd: number; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }; contextTokens: number; resultText: string }

// The Claude-only part of the settings: permissions and the sandbox flags. The network and read rules every harness shares live in sandbox-rules.json.
export const CLAUDE_SETTINGS_PATH = fileURLToPath(new URL("../../.claude/factory-settings.json", import.meta.url));
// The inbox hook script. The hook's cwd is the target clone, so the path is absolute.
export const INBOX_HOOK = fileURLToPath(new URL("./claude-inbox-hook.ts", import.meta.url));

// The settings the agent runs with: the factory file, a hook from a fixed absolute dir, Read denies for the config dir,
// and the same sandbox rules as install and gate commands. cwd is the target clone.
// With an inbox file, a second hook hands new ticket comments to the agent after every tool call (see claude-inbox-hook.ts).
export function factorySettings(env: NodeJS.ProcessEnv, hooksDir: string, cwd: string, inboxFile?: string, preview = false, platform = process.platform): any {
  const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, "utf8"));
  const rules = JSON.parse(readFileSync(SANDBOX_RULES_PATH, "utf8"));
  const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`; // safe for spaces, quotes and backslashes
  settings.hooks = { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: quote(`${hooksDir}/deny-dangerous.sh`) }] }] };
  if (inboxFile) settings.hooks.PostToolUse = [{ hooks: [{ type: "command", command: `node --import ${quote(TSX_IMPORT)} ${quote(INBOX_HOOK)} ${quote(inboxFile)}` }] }];
  if (env.CLAUDE_CONFIG_DIR) settings.permissions.deny.push(`Read(/${env.CLAUDE_CONFIG_DIR}/**)`);
  if (env.HOME) settings.permissions.deny.push(`Read(/${env.HOME}/.*/**)`);
  settings.sandbox.network.allowedDomains = rules.network.allowedDomains;
  settings.sandbox.filesystem = { denyRead: sandboxDenyRead(cwd) };
  if (preview) settings.sandbox.network.allowLocalBinding = true; // the author starts the target's dev server
  // tsx always opens an IPC pipe in TMPDIR (/tmp/claude in the sandbox). macOS allows it through allowUnixSockets;
  // Linux ignores those paths and needs every unix socket allowed. The worker's step containers mount no host socket.
  if (platform === "linux") settings.sandbox.network.allowAllUnixSockets = true;
  return settings;
}

// With images the prompt goes on stdin as one stream-json user message (see claudeInput), since -p takes text only.
// The effort is a flag: a "/effort" line in a print-mode prompt takes the whole prompt as its argument and fails.
export function buildClaudeArgs(r: ClaudeRun & { tools?: "code" | "none" }, settingsPath = CLAUDE_SETTINGS_PATH): string[] {
  return [
    ...(r.images ? ["-p", "--input-format", "stream-json"] : ["-p", r.prompt]),
    "--effort", r.effort,
    "--output-format", "stream-json", "--verbose",
    "--settings", settingsPath,
    "--setting-sources", "user", // do not merge the target repo's own .claude/settings*.json
    "--permission-mode", "dontAsk", "--permission-prompts", "none",
    "--max-turns", String(r.maxTurns), "--model", r.model,
    ...(r.tools === "none" ? ["--tools", ""] : []),
    ...(r.resumeSessionId ? ["--resume", r.resumeSessionId] : []),
  ];
}

// The stdin line for a run with images: the prompt, then each PNG in the order the prompt lists them.
export function claudeInput(prompt: string, images: { data: Buffer }[]): string {
  const blocks = images.map((i) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: i.data.toString("base64") } }));
  return `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt }, ...blocks] } })}\n`;
}

// Keep only these variables, and only when they are set. No GitLab, Teams or other secrets.
// The provider's key goes in under the name Claude Code reads.
export function agentEnv(env: NodeJS.ProcessEnv, provider: Provider): NodeJS.ProcessEnv {
  const oauth = provider.keyEnv === "CLAUDE_CODE_OAUTH_TOKEN";
  const out: NodeJS.ProcessEnv = {
    ...Object.fromEntries(["PATH", "HOME", "LANG", "CLAUDE_CONFIG_DIR", "PLAYWRIGHT_BROWSERS_PATH"].map((k) => [k, env[k]])),
    [oauth ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY"]: env[provider.keyEnv],
    ...(!oauth && provider.baseUrl ? { ANTHROPIC_BASE_URL: provider.baseUrl } : {}),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

// Pairs each tool_use (assistant line) with its tool_result (user line) by id. Feed it the stream line by line.
export function toolCalls(now: () => number = Date.now): { line(l: string): ToolCall[] } {
  const open = new Map<string, { name: string; input: string; at: number }>();
  const text = (c: any): string => (typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => x?.text ?? "").join("") : "");
  return {
    line(l) {
      let e: any;
      try { e = JSON.parse(l); } catch { return []; }
      const blocks: any[] = Array.isArray(e?.message?.content) ? e.message.content : [];
      const done: ToolCall[] = [];
      for (const b of blocks) {
        if (e.type === "assistant" && b?.type === "tool_use") open.set(String(b.id), { name: String(b.name), input: JSON.stringify(b.input ?? {}), at: now() });
        if (e.type === "user" && b?.type === "tool_result") {
          const start = open.get(String(b.tool_use_id));
          if (!start) continue;
          open.delete(String(b.tool_use_id));
          done.push({ name: start.name, input: start.input, result: text(b.content), ms: now() - start.at, ok: !b.is_error });
        }
      }
      return done;
    },
  };
}

export function parseStream(jsonl: string, exitCode: number | null = 0): ClaudeResult {
  let result: any;
  let lastUsage: any; // usage of the last model turn
  let retryLimit = false;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "system" && e.subtype === "api_retry" && ["rate_limit", "billing_error"].includes(e.error)) retryLimit = true;
    if (e.type === "result") result = e;
    if (e.type === "assistant" && e.message?.usage) lastUsage = e.message.usage;
  }
  if (!result) throw new Error("Claude stream has no final result event (cut off?)");
  const text = String(result.result ?? "");
  const resultError = Boolean(result.is_error);
  // A limit counts only on an error result: a retry the CLI recovered from, or a normal answer that says
  // "usage limit", is not a hit.
  const limitHit = resultError && (retryLimit || /usage limit/i.test(text));
  return {
    sessionId: String(result.session_id ?? ""),
    isError: resultError || limitHit || result.subtype !== "success" || exitCode !== 0,
    limitHit,
    costUsd: Number(result.total_cost_usd ?? 0),
    tokens: {
      input: Number(result.usage?.input_tokens ?? 0), output: Number(result.usage?.output_tokens ?? 0),
      cacheRead: Number(result.usage?.cache_read_input_tokens ?? 0), cacheWrite: Number(result.usage?.cache_creation_input_tokens ?? 0),
    },
    contextTokens: Number(lastUsage?.input_tokens ?? 0) + Number(lastUsage?.cache_read_input_tokens ?? 0) + Number(lastUsage?.cache_creation_input_tokens ?? 0),
    resultText: text,
  };
}

export const claudeCode: Harness = {
  apis: ["anthropic"],
  home: HARNESS_HOMES["claude-code"],
  images: true,
  async run(job: HarnessJob): Promise<HarnessResult> {
    guardReady(HOOKS_DIR); // fail closed: never start without the command guard
    let cwd = job.cwd;
    let dir = "";
    let pump: ReturnType<typeof pumpInbox> | undefined;
    try {
      // Without tools there is nothing to read in the target clone, so run in an empty dir.
      if (job.tools === "none") cwd = mkdtempSync(join(tmpdir(), "claude-empty-"));
      dir = mkdtempSync(join(tmpdir(), "claude-settings-"));
      const path = join(dir, "settings.json");
      // The inbox file sits in the settings dir, outside the clone, so the agent's own commands cannot write to it.
      const inboxFile = job.inbox ? join(dir, "inbox.jsonl") : undefined;
      writeFileSync(path, JSON.stringify(factorySettings(process.env, HOOKS_DIR, cwd, inboxFile, job.preview)));
      if (job.inbox && inboxFile) pump = pumpInbox(job.inbox, inboxFile);
      const run: ClaudeRun & { tools: "code" | "none" } = { prompt: job.prompt, model: job.model.model, effort: job.model.effort ?? "medium", maxTurns: job.maxTurns, cwd, resumeSessionId: job.resume, tools: job.tools, images: Boolean(job.images?.length) };
      const calls = toolCalls();
      const onLine = job.onToolCall && ((l: string) => calls.line(l).forEach(job.onToolCall!));
      const { code, out, err } = await runCommand("claude", buildClaudeArgs(run, path), agentEnv(process.env, job.model.provider), cwd, run.images ? claudeInput(job.prompt, job.images!) : undefined, onLine);
      // The hook stops the agent at its next tool call after a stop line. A run that was stopped is never ok.
      const stopped = (await pump?.end()) ?? false;
      pump = undefined;
      try {
        const r = parseStream(out, code);
        return { session: r.sessionId, ok: !r.isError && !stopped, limitHit: r.limitHit, stopped, costUsd: r.costUsd, tokens: r.tokens, contextTokens: r.contextTokens, text: r.resultText };
      } catch (e) { // a stream cut before the result event is a failed run, not a crash
        return { session: "", ok: false, limitHit: false, stopped, costUsd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextTokens: 0, text: `${(e as Error).message} Exit code ${code}. The end of its error output:\n${err.trim() || "(empty)"}` };
      }
    } finally {
      await pump?.end(); // only still set when the run threw
      if (dir) rmSync(dir, { recursive: true, force: true });
      if (cwd !== job.cwd) rmSync(cwd, { recursive: true, force: true });
    }
  },
};
