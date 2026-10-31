import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { SETTINGS_PATH } from "../agents";
import type { HarnessJob, Provider } from "../seams";
import { agentEnv, buildClaudeArgs, claudeCode, parseStream } from "./claude-code";

const load = (f: string) => readFileSync(new URL(`../fixtures/${f}`, import.meta.url), "utf8");
const teamPlan: Provider = { name: "team-plan", api: "anthropic", keyEnv: "CLAUDE_CODE_OAUTH_TOKEN", models: { "claude-sonnet-5-5": "claude" } };

test("every run carries the fixed flags and never --bare", () => {
  const a = buildClaudeArgs({ prompt: "p", model: "claude-sonnet-5-5", effort: "medium", maxTurns: 60, cwd: "/w" });
  expect(a).toEqual(expect.arrayContaining(["-p", "--output-format", "stream-json", "--verbose", "--settings", SETTINGS_PATH, "--setting-sources", "user", "--permission-mode", "dontAsk", "--permission-prompts", "none", "--max-turns", "60", "--model", "claude-sonnet-5-5"]));
  expect(a).not.toContain("--bare");
  expect(a).not.toContain("--tools");
});
test("the prompt starts with the effort command", () => {
  const a = buildClaudeArgs({ prompt: "do it", model: "m", effort: "high", maxTurns: 1, cwd: "/w" });
  expect(a[a.indexOf("-p") + 1]).toBe("/effort high\ndo it");
});
test("resume passes the session id", () => expect(buildClaudeArgs({ prompt: "p", model: "m", effort: "high", maxTurns: 1, cwd: "/w", resumeSessionId: "s1" })).toEqual(expect.arrayContaining(["--resume", "s1"])));
test("no tools turns every built-in tool off", () => {
  const a = buildClaudeArgs({ prompt: "p", model: "m", effort: "high", maxTurns: 1, cwd: "/w", tools: "none" });
  expect(a.slice(a.indexOf("--tools"), a.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
});

test("agents never get the GitLab token or another provider's key", () => {
  const env = { PATH: "/bin", HOME: "/h", LANG: "C", CLAUDE_CONFIG_DIR: "/c", FACTORY_GITLAB_TOKEN: "x", TEAMS_WEBHOOK_URL: "y", BERGET_API_KEY: "b", TENSORX_API_KEY: "tx", ANTHROPIC_API_KEY: "z", CLAUDE_CODE_OAUTH_TOKEN: "t" };
  expect(agentEnv(env, teamPlan)).toEqual({ PATH: "/bin", HOME: "/h", LANG: "C", CLAUDE_CONFIG_DIR: "/c", CLAUDE_CODE_OAUTH_TOKEN: "t" });
});
test("agents keep the browser path when it is set", () => {
  expect(agentEnv({ PATH: "/bin", PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright", CLAUDE_CODE_OAUTH_TOKEN: "t" }, teamPlan).PLAYWRIGHT_BROWSERS_PATH).toBe("/ms-playwright");
});
test("another Anthropic-style provider's key is passed as ANTHROPIC_API_KEY with its base URL", () => {
  const p: Provider = { name: "gw", api: "anthropic", baseUrl: "https://gw.example", keyEnv: "GW_KEY", models: {} };
  expect(agentEnv({ PATH: "/bin", GW_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "t", FACTORY_GITLAB_TOKEN: "g" }, p)).toEqual({ PATH: "/bin", ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "https://gw.example" });
});

test("the stream gives session id, cost and tokens", () => expect(parseStream(load("stream-ok.jsonl"))).toMatchObject({ isError: false, limitHit: false, costUsd: 0.0042, tokens: { input: 120, output: 8 }, resultText: "ok", sessionId: "11111111-1111-4111-8111-111111111111" }));
test("a usage limit is reported as limitHit, not as a plain error", () => expect(parseStream(load("stream-limit.jsonl"))).toMatchObject({ isError: true, limitHit: true }));
test("a rate_limit retry event alone marks limitHit, and forces isError", () => {
  const s = load("stream-limit.jsonl").split("\n").filter(Boolean);
  const r = JSON.parse(s[2]);
  r.is_error = false; r.result = "done";
  expect(parseStream([s[0], s[1], JSON.stringify(r)].join("\n"))).toMatchObject({ isError: true, limitHit: true });
});
test("a plain error is not a limit hit", () => expect(parseStream(load("stream-error.jsonl"))).toMatchObject({ isError: true, limitHit: false }));
test("billing_error alone is a limit hit", () => {
  const lines = load("stream-limit.jsonl").replace("rate_limit", "billing_error").split("\n").filter(Boolean);
  const r = JSON.parse(lines[2]); r.result = "failed";
  expect(parseStream([lines[0], lines[1], JSON.stringify(r)].join("\n"))).toMatchObject({ isError: true, limitHit: true });
});
test("usage-limit text alone is a limit hit", () => {
  const lines = load("stream-limit.jsonl").split("\n").filter(Boolean);
  expect(parseStream([lines[0], lines[2]].join("\n"))).toMatchObject({ isError: true, limitHit: true });
});
test("usage-limit text in a successful result is not a limit hit", () => {
  const r = JSON.parse(load("stream-ok.jsonl").split("\n")[2]); r.result = "The usage limit docs say...";
  expect(parseStream(JSON.stringify(r))).toMatchObject({ isError: false, limitHit: false });
});
test("a non-success subtype or a non-zero exit code is an error", () => {
  const r = JSON.parse(load("stream-ok.jsonl").split("\n")[2]);
  expect(parseStream(JSON.stringify({ ...r, subtype: "error_max_turns" }))).toMatchObject({ isError: true, limitHit: false });
  expect(parseStream(JSON.stringify(r), 1).isError).toBe(true);
});
test("a cut-off stream throws", () => expect(() => parseStream(load("stream-ok.jsonl").split("\n").slice(0, 2).join("\n"))).toThrow(/result/));

// --- the harness itself, against a fake `claude` program on PATH ---
const origPath = process.env.PATH;
afterEach(() => { process.env.PATH = origPath; vi.unstubAllEnvs(); });

// Puts a `claude` script first on PATH. It records its args, cwd and env in the returned dir, then prints `fixture`.
function fakeClaude(fixture: string, lines?: number) {
  const bin = realpathSync(mkdtempSync(join(tmpdir(), "fake-claude-")));
  const script = join(bin, "claude");
  writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$@" > "${bin}/args"\npwd > "${bin}/cwd"\nenv > "${bin}/env"\nhead -n ${lines ?? 1000} "${new URL(`../fixtures/${fixture}`, import.meta.url).pathname}"\n`);
  chmodSync(script, 0o755);
  process.env.PATH = `${bin}:${origPath}`;
  return bin;
}
const job = (over: Partial<HarnessJob> = {}): HarnessJob => ({ role: "author", prompt: "p", model: { provider: teamPlan, model: "claude-sonnet-5-5", effort: "medium" }, cwd: realpathSync(tmpdir()), tools: "code", maxTurns: 3, ...over });

test("a code job runs in the job cwd and maps the stream to a result", async () => {
  const bin = fakeClaude("stream-ok.jsonl");
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "tok");
  vi.stubEnv("FACTORY_GITLAB_TOKEN", "gl-secret");
  vi.stubEnv("TENSORX_API_KEY", "tx-secret");
  const r = await claudeCode.run(job());
  expect(r).toEqual({ session: "11111111-1111-4111-8111-111111111111", ok: true, limitHit: false, stopped: false, costUsd: 0.0042, tokens: { input: 120, output: 8 }, text: "ok" });
  expect(readFileSync(join(bin, "cwd"), "utf8").trim()).toBe(realpathSync(tmpdir()));
  expect(readFileSync(join(bin, "args"), "utf8")).not.toContain("--tools");
  const env = readFileSync(join(bin, "env"), "utf8");
  expect(env).toContain("CLAUDE_CODE_OAUTH_TOKEN=tok");
  expect(env).not.toMatch(/gl-secret|tx-secret/);
});

test("a no-tools job passes --tools '' and runs in an empty dir, not the job cwd", async () => {
  const bin = fakeClaude("stream-ok.jsonl");
  await claudeCode.run(job({ role: "writer", tools: "none" }));
  const args = readFileSync(join(bin, "args"), "utf8").split("\n");
  expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
  expect(readFileSync(join(bin, "cwd"), "utf8").trim()).not.toBe(realpathSync(tmpdir()));
});

test("a stream cut before the result event is a failed run, not a throw", async () => {
  fakeClaude("stream-ok.jsonl", 2);
  expect(await claudeCode.run(job())).toMatchObject({ ok: false, limitHit: false, stopped: false });
});

test("a usage limit comes back as limitHit", async () => {
  fakeClaude("stream-limit.jsonl");
  expect(await claudeCode.run(job())).toMatchObject({ ok: false, limitHit: true });
});

test("the harness refuses to start when the command guard cannot run, and never starts claude", async () => {
  const bin = fakeClaude("stream-ok.jsonl");
  process.env.PATH = bin; // fake claude only: no jq, so the guard cannot run
  await expect(claudeCode.run(job())).rejects.toThrow(/jq/);
  expect(() => readFileSync(join(bin, "args"))).toThrow();
});

test("a stop in the inbox gives stopped, never ok, and keeps the session for a resume", async () => {
  fakeClaude("stream-ok.jsonl");
  const r = await claudeCode.run(job({ inbox: { poll: async () => ({ comments: [], stop: true }) } }));
  expect(r).toMatchObject({ ok: false, stopped: true, session: "11111111-1111-4111-8111-111111111111" });
});
test("an inbox with no stop leaves the run ok, and it is polled once at the start", async () => {
  fakeClaude("stream-ok.jsonl");
  let polls = 0;
  const r = await claudeCode.run(job({ inbox: { poll: async () => (polls++, { comments: ["c"], stop: false }) } }));
  expect(r).toMatchObject({ ok: true, stopped: false });
  expect(polls).toBe(1); // at once, and the next one is 60 s away
});
test("a job with no inbox is not polled and its result is not stopped", async () => {
  fakeClaude("stream-ok.jsonl");
  expect(await claudeCode.run(job())).toMatchObject({ ok: true, stopped: false });
});
test("the run's settings carry the inbox hook only when the job has an inbox", async () => {
  const bin = fakeClaude("stream-ok.jsonl");
  // The settings file is deleted when the run ends, so the fake claude copies it while it runs.
  writeFileSync(join(bin, "claude"), readFileSync(join(bin, "claude"), "utf8").replace("head -n", `cp "$(printf '%s\\n' "$@" | sed -n '/settings.json$/p')" "${bin}/settings.json"\nhead -n`));
  await claudeCode.run(job({ inbox: { poll: async () => ({ comments: [], stop: false }) } }));
  expect(JSON.parse(readFileSync(join(bin, "settings.json"), "utf8")).hooks.PostToolUse[0].hooks[0].command).toContain("claude-inbox-hook.ts");
  await claudeCode.run(job());
  expect(JSON.parse(readFileSync(join(bin, "settings.json"), "utf8")).hooks.PostToolUse).toBeUndefined();
});
