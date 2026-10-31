import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOKS_DIR, SETTINGS_PATH, factorySettings, guardReady, runCommand, type ClaudeResult, type ClaudeRun } from "../agents";
import { pumpInbox } from "../inbox";
import type { Harness, HarnessJob, HarnessResult, Provider, ToolCall } from "../seams";

export function buildClaudeArgs(r: ClaudeRun & { tools?: "code" | "none" }, settingsPath = SETTINGS_PATH): string[] {
  return [
    "-p", `/effort ${r.effort}\n${r.prompt}`,
    "--output-format", "stream-json", "--verbose",
    "--settings", settingsPath,
    "--setting-sources", "user", // do not merge the target repo's own .claude/settings*.json
    "--permission-mode", "dontAsk", "--permission-prompts", "none",
    "--max-turns", String(r.maxTurns), "--model", r.model,
    ...(r.tools === "none" ? ["--tools", ""] : []),
    ...(r.resumeSessionId ? ["--resume", r.resumeSessionId] : []),
  ];
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
  images: false, // ponytail: Claude Code can take images through --input-format stream-json; add it when a claude-code reviewer is configured
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
      const run: ClaudeRun & { tools: "code" | "none" } = { prompt: job.prompt, model: job.model.model, effort: job.model.effort ?? "medium", maxTurns: job.maxTurns, cwd, resumeSessionId: job.resume, tools: job.tools };
      const calls = toolCalls();
      const onLine = job.onToolCall && ((l: string) => calls.line(l).forEach(job.onToolCall!));
      const { code, out, err } = await runCommand("claude", buildClaudeArgs(run, path), agentEnv(process.env, job.model.provider), cwd, undefined, onLine);
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
