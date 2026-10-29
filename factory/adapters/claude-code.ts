import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOKS_DIR, SETTINGS_PATH, factorySettings, guardReady, runCommand, type ClaudeResult, type ClaudeRun } from "../agents";
import { pumpInbox } from "../inbox";
import type { Harness, HarnessJob, HarnessResult, Provider } from "../seams";

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
    ...Object.fromEntries(["PATH", "HOME", "LANG", "CLAUDE_CONFIG_DIR"].map((k) => [k, env[k]])),
    [oauth ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY"]: env[provider.keyEnv],
    ...(!oauth && provider.baseUrl ? { ANTHROPIC_BASE_URL: provider.baseUrl } : {}),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

export function parseStream(jsonl: string, exitCode: number | null = 0): ClaudeResult {
  let result: any;
  let retryLimit = false;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "system" && e.subtype === "api_retry" && ["rate_limit", "billing_error"].includes(e.error)) retryLimit = true;
    if (e.type === "result") result = e;
  }
  if (!result) throw new Error("Claude stream has no final result event (cut off?)");
  const text = String(result.result ?? "");
  const resultError = Boolean(result.is_error);
  // The usage-limit text counts only on an error result, so a normal answer that says "usage limit" is not a hit.
  const limitHit = retryLimit || (resultError && /usage limit/i.test(text));
  return {
    sessionId: String(result.session_id ?? ""),
    isError: resultError || limitHit || result.subtype !== "success" || exitCode !== 0,
    limitHit,
    costUsd: Number(result.total_cost_usd ?? 0),
    tokens: { input: Number(result.usage?.input_tokens ?? 0), output: Number(result.usage?.output_tokens ?? 0) },
    resultText: text,
  };
}

export const claudeCode: Harness = {
  apis: ["anthropic"],
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
      writeFileSync(path, JSON.stringify(factorySettings(process.env, HOOKS_DIR, cwd, inboxFile)));
      if (job.inbox && inboxFile) pump = pumpInbox(job.inbox, inboxFile);
      const run: ClaudeRun & { tools: "code" | "none" } = { prompt: job.prompt, model: job.model.model, effort: job.model.effort ?? "medium", maxTurns: job.maxTurns, cwd, resumeSessionId: job.resume, tools: job.tools };
      const { code, out } = await runCommand("claude", buildClaudeArgs(run, path), agentEnv(process.env, job.model.provider), cwd);
      // The hook stops the agent at its next tool call after a stop line. A run that was stopped is never ok.
      const stopped = (await pump?.end()) ?? false;
      pump = undefined;
      try {
        const r = parseStream(out, code);
        return { session: r.sessionId, ok: !r.isError && !stopped, limitHit: r.limitHit, stopped, costUsd: r.costUsd, tokens: r.tokens, text: r.resultText };
      } catch (e) { // a stream cut before the result event is a failed run, not a crash
        return { session: "", ok: false, limitHit: false, stopped, costUsd: 0, tokens: { input: 0, output: 0 }, text: (e as Error).message };
      }
    } finally {
      await pump?.end(); // only still set when the run threw
      if (dir) rmSync(dir, { recursive: true, force: true });
      if (cwd !== job.cwd) rmSync(cwd, { recursive: true, force: true });
    }
  },
};
