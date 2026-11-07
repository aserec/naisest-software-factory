import { rootReads } from "../sandbox";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { HOOKS_DIR, TSX_IMPORT } from "../agents";
import { sandboxSettings } from "../repo";
import type { HarnessJob, Provider } from "../seams";
import { CLAUDE_SETTINGS_PATH, INBOX_HOOK, claudeEnv, buildClaudeArgs, claudeCode, claudeInput, factorySettings, codeEnv, withRootReads, parseStream, toolCalls } from "./claude-code";

const load = (f: string) => readFileSync(new URL(`../fixtures/${f}`, import.meta.url), "utf8");
const teamPlan: Provider = { name: "team-plan", api: "anthropic", keyEnv: "CLAUDE_CODE_OAUTH_TOKEN", models: { "claude-sonnet-5-5": "claude" } };

test("every run carries the fixed flags and never --bare", () => {
  const a = buildClaudeArgs({ prompt: "p", model: "claude-sonnet-5-5", effort: "medium", maxTurns: 60, cwd: "/w" });
  expect(a).toEqual(expect.arrayContaining(["-p", "--output-format", "stream-json", "--verbose", "--settings", CLAUDE_SETTINGS_PATH, "--setting-sources", "user", "--permission-mode", "dontAsk", "--permission-prompts", "none", "--max-turns", "60", "--model", "claude-sonnet-5-5"]));
  expect(a).not.toContain("--bare");
  expect(a).not.toContain("--tools");
});
test("the prompt follows -p as it is, and the effort is a flag", () => {
  const a = buildClaudeArgs({ prompt: "do it", model: "m", effort: "high", maxTurns: 1, cwd: "/w" });
  expect(a[a.indexOf("-p") + 1]).toBe("do it");
  expect(a.slice(a.indexOf("--effort"), a.indexOf("--effort") + 2)).toEqual(["--effort", "high"]);
});
test("with images the prompt and the PNGs go on stdin as one stream-json user message", () => {
  const a = buildClaudeArgs({ prompt: "do it", model: "m", effort: "high", maxTurns: 1, cwd: "/w", images: true });
  expect(a.slice(a.indexOf("-p"), a.indexOf("-p") + 3)).toEqual(["-p", "--input-format", "stream-json"]);
  expect(a).not.toContain("do it");
  expect(JSON.parse(claudeInput("do it", [{ data: Buffer.from("a") }, { data: Buffer.from("b") }]))).toEqual({ type: "user", message: { role: "user", content: [
    { type: "text", text: "do it" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "YQ==" } },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "Yg==" } },
  ] } });
});
test("resume passes the session id", () => expect(buildClaudeArgs({ prompt: "p", model: "m", effort: "high", maxTurns: 1, cwd: "/w", resumeSessionId: "s1" })).toEqual(expect.arrayContaining(["--resume", "s1"])));
test("no tools turns every built-in tool off", () => {
  const a = buildClaudeArgs({ prompt: "p", model: "m", effort: "high", maxTurns: 1, cwd: "/w", tools: "none" });
  expect(a.slice(a.indexOf("--tools"), a.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
});

test("agents never get the GitLab token or another provider's key", () => {
  const env = { PATH: "/bin", HOME: "/h", LANG: "C", CLAUDE_CONFIG_DIR: "/c", FACTORY_GITLAB_TOKEN: "x", TEAMS_WEBHOOK_URL: "y", CELERIS_API_KEY: "b", TENSORX_API_KEY: "tx", ANTHROPIC_API_KEY: "z", CLAUDE_CODE_OAUTH_TOKEN: "t" };
  expect(claudeEnv(env, teamPlan)).toEqual({ PATH: "/bin", HOME: "/h", LANG: "C", CLAUDE_CONFIG_DIR: "/c", CLAUDE_CODE_OAUTH_TOKEN: "t" });
});
test("agents keep the browser path when it is set", () => {
  expect(claudeEnv({ PATH: "/bin", PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright", CLAUDE_CODE_OAUTH_TOKEN: "t" }, teamPlan).PLAYWRIGHT_BROWSERS_PATH).toBe("/ms-playwright");
});
test("another Anthropic-style provider's key is passed as ANTHROPIC_API_KEY with its base URL", () => {
  const p: Provider = { name: "gw", api: "anthropic", baseUrl: "https://gw.example", keyEnv: "GW_KEY", models: {} };
  expect(claudeEnv({ PATH: "/bin", GW_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "t", FACTORY_GITLAB_TOKEN: "g" }, p)).toEqual({ PATH: "/bin", ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "https://gw.example" });
});

test("the stream gives session id, cost and tokens", () => expect(parseStream(load("stream-ok.jsonl"))).toMatchObject({ isError: false, limitHit: false, costUsd: 0.0042, tokens: { input: 120, output: 8 }, resultText: "ok", sessionId: "11111111-1111-4111-8111-111111111111" }));
test("a usage limit is reported as limitHit, not as a plain error", () => expect(parseStream(load("stream-limit.jsonl"))).toMatchObject({ isError: true, limitHit: true }));
test("a rate_limit retry the CLI recovered from is not a limit hit", () => {
  const s = load("stream-limit.jsonl").split("\n").filter(Boolean);
  const r = JSON.parse(s[2]);
  r.is_error = false; r.result = "done";
  expect(parseStream([s[0], s[1], JSON.stringify(r)].join("\n"))).toMatchObject({ isError: false, limitHit: false });
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
  writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$@" > "${bin}/args"\npwd > "${bin}/cwd"\nenv > "${bin}/env"\n[ -t 0 ] || cat > "${bin}/stdin"\nhead -n ${lines ?? 1000} "${new URL(`../fixtures/${fixture}`, import.meta.url).pathname}"\n`);
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
  expect(r).toEqual({ session: "11111111-1111-4111-8111-111111111111", ok: true, limitHit: false, stopped: false, costUsd: 0.0042, tokens: { input: 120, output: 8, cacheRead: 0, cacheWrite: 0 }, contextTokens: 0, text: "ok" });
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

test("a job with images writes them to claude's stdin", async () => {
  const bin = fakeClaude("stream-ok.jsonl");
  await claudeCode.run(job({ role: "reviewer", tools: "none", images: [{ name: "a.png", data: Buffer.from("png") }] }));
  expect(JSON.parse(readFileSync(join(bin, "stdin"), "utf8")).message.content[1].source.data).toBe("cG5n");
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

test("a stream with tools gives one call per tool_result, paired by id, with ok from is_error", () => {
  let t = 0;
  const calls = toolCalls(() => (t += 50));
  const got = load("claude-stream-tools.jsonl").split("\n").filter(Boolean).flatMap((l) => calls.line(l));
  expect(got).toEqual([
    { name: "Read", input: JSON.stringify({ file_path: "src/List.tsx" }), result: "export const List = () => null;", ms: 50, ok: true },
    { name: "Bash", input: JSON.stringify({ command: "pnpm test" }), result: "1 test failed", ms: 50, ok: false },
  ]);
});
test("toolCalls skips a line that is not JSON, a result with no matching call, and gives each call once", () => {
  const calls = toolCalls();
  const r = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "nope", content: "x" }] } });
  expect([calls.line("not json"), calls.line(r), calls.line("")]).toEqual([[], [], []]);
});
test("the stream gives cache tokens, and the context size of the last model turn", () => {
  expect(parseStream(load("claude-stream-tools.jsonl"))).toMatchObject({ tokens: { input: 36, output: 13, cacheRead: 450, cacheWrite: 70 }, contextTokens: 14 + 200 + 20 });
});
test("a job with onToolCall gets each tool call while claude runs; a job without it still runs", async () => {
  fakeClaude("claude-stream-tools.jsonl");
  const seen: string[] = [];
  const r = await claudeCode.run(job({ onToolCall: (c) => seen.push(`${c.name}:${c.ok}`) }));
  expect(seen).toEqual(["Read:true", "Bash:false"]);
  expect(r).toMatchObject({ ok: true, tokens: { cacheRead: 450, cacheWrite: 70 }, contextTokens: 234 });
  expect(await claudeCode.run(job())).toMatchObject({ ok: true });
});

// The fixture was written from the code before the Claude settings moved here. <ROOT> is the factory checkout.
const pinned = () => JSON.parse(load("claude-settings.json").replaceAll("<INBOX_HOOK>", INBOX_HOOK).replaceAll("<TSX_IMPORT>", TSX_IMPORT).replaceAll("<ROOT>", fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "")));
test("the Claude settings stay exactly as before the split", () => {
  expect(factorySettings({ CLAUDE_CONFIG_DIR: "/cfg", HOME: "/home/a" }, "/opt/hooks", "/w/run/target", "/w/run/inbox.jsonl", true, "darwin")).toEqual(pinned());
});
test("tsx can open its IPC pipe: macOS allows the sandbox TMPDIR, Linux allows every unix socket", () => {
  const mac = factorySettings({}, "/opt/hooks", "/w/run/target", undefined, false, "darwin").sandbox.network;
  expect(mac.allowUnixSockets).toEqual(["/tmp/claude", "/private/tmp/claude"]);
  expect(mac.allowAllUnixSockets).toBeUndefined();
  expect(factorySettings({}, "/opt/hooks", "/w/run/target", undefined, false, "linux").sandbox.network.allowAllUnixSockets).toBe(true);
});
test("repo sandbox settings keep the same allowed domains", () => {
  expect(sandboxSettings("/w/run/target", "/h").network.allowedDomains).toEqual(pinned().sandbox.network.allowedDomains);
});

test("settings path is absolute and exists, so the agent cwd cannot replace it", () => {
  expect(isAbsolute(CLAUDE_SETTINGS_PATH)).toBe(true);
  expect(JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, "utf8")).sandbox.autoAllowBashIfSandboxed).toBe(false);
});
test("settings pin the hook to the given absolute dir and deny the config dir", () => {
  const s = factorySettings({ CLAUDE_CONFIG_DIR: "/cfg", HOME: "/home/a" }, "/opt/hooks", "/w/run/target");
  expect(s.hooks.PreToolUse[0].hooks[0].command).toBe("'/opt/hooks/deny-dangerous.sh'");
  expect(s.permissions.deny).toEqual(expect.arrayContaining(["Edit(./.git/**)", "Write(./.git/**)"]));
  expect(s.permissions.blockReadsOutsideWorkingDirectories).toBe(true);
  const odd = factorySettings({}, `/a b/it's "x"\\y`, "/w/run/target");
  expect(odd.hooks.PreToolUse[0].hooks[0].command).toBe(`'/a b/it'\\''s "x"\\y/deny-dangerous.sh'`);
  expect(s.permissions.deny).toEqual(expect.arrayContaining(["Read(//cfg/**)", "Read(//proc/**)", "Edit(./.claude/**)", "Bash(git -C*)"]));
  expect(s.permissions.allow).toEqual(expect.arrayContaining(["Read(./**)"]));
  expect(s.permissions.allow).not.toContain("Read");
});
// The agent edits files with Edit and Write, which cannot delete one. Ticket 496 asked to delete three files and blocked at review.
test("settings let the agent delete files in the clone with git rm, and nothing else that deletes", () => {
  const s = factorySettings({}, "/opt/hooks", "/w/run/target");
  expect(s.permissions.allow).toContain("Bash(git rm*)");
  expect(s.permissions.allow.filter((p: string) => /^Bash\((rm|rmdir|unlink)\b/.test(p))).toEqual([]);
});
// A ticket can add a script and ask that it passes (ticket 500: typecheck). The author already edits package.json and
// runs its test script, so any script adds no power; the sandbox contains them all.
test("settings let the agent run any package script", () => {
  const s = factorySettings({}, "/opt/hooks", "/w/run/target");
  expect(s.permissions.allow).toEqual(expect.arrayContaining(["Bash(pnpm run*)", "Bash(npm run*)"]));
});
test("agent settings on macOS let fs.watch reach FSEvents, like the gate", () => {
  expect(factorySettings({}, "/opt/hooks", "/w/run/target", undefined, true, "darwin").sandbox.network.allowMachLookup).toEqual(["com.apple.FSEvents"]);
  expect(factorySettings({}, "/opt/hooks", "/w/run/target", undefined, true, "linux").sandbox.network).not.toHaveProperty("allowMachLookup");
});
test("settings allow local binding for a preview or a local run, as the gate does", () => {
  expect(factorySettings({}, "/opt/hooks", "/w/run/target", undefined, true).sandbox.network.allowLocalBinding).toBe(true);
  // A local run's tests reach the Mac's services, such as Postgres on localhost:5432.
  expect(factorySettings({ FACTORY_PNPM_STORE: "/w/pnpm-store" }, "/opt/hooks", "/w/run/target").sandbox.network.allowLocalBinding).toBe(true);
  expect(factorySettings({}, "/opt/hooks", "/w/run/target").sandbox.network.allowLocalBinding).toBeFalsy();
});
test("the agent sandbox denies the same reads as the gate sandbox", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
  const s = factorySettings({}, "/opt/hooks", "/w/run/target");
  expect(s.sandbox.filesystem.denyRead).toEqual(["/proc", `${root}/.git`, `${root}.tmp`, "/w/run/claude-home", "/w/run/pi-home"]);
  expect(s.sandbox.filesystem.denyRead).toEqual(sandboxSettings("/w/run/target", "/tmp/h").filesystem.denyRead);
});

test("author settings run the hook after every tool, and settings without an inbox have none", () => {
  const withInbox = factorySettings({}, HOOKS_DIR, "/w/run/target", "/tmp/i box/inbox.jsonl");
  const cmd = withInbox.hooks.PostToolUse[0].hooks[0].command;
  expect(cmd).toContain(`'${INBOX_HOOK}' '/tmp/i box/inbox.jsonl'`);
  expect(withInbox.hooks.PreToolUse).toBeDefined();
  expect(factorySettings({}, HOOKS_DIR, "/w/run/target").hooks.PostToolUse).toBeUndefined();
});

test("settings allow the target's own commands with any arguments, and nothing else new", () => {
  const s = factorySettings({}, "/opt/hooks", "/w/run/target", undefined, false, "darwin", ["npm run lint", "npm run test"]);
  expect(s.permissions.allow).toEqual(expect.arrayContaining(["Bash(npm run lint*)", "Bash(npm run test*)"]));
  expect(s.permissions.allow.length).toBe(factorySettings({}, "/opt/hooks", "/w/run/target").permissions.allow.length + 2);
});

test("an nvm node under HOME gets its install dir readable in the sandbox; a node elsewhere adds nothing", () => {
  const nvm = factorySettings({ HOME: "/home/a" }, "/opt/hooks", "/w/run/target", undefined, false, "darwin", [], "/home/a/.nvm/versions/node/v22/bin/node");
  expect(nvm.sandbox.filesystem.allowRead).toEqual(["/home/a/.nvm/versions/node/v22", "/home/a/Library/Caches/ms-playwright", "/home/a/.local/share/uv/python"]);
  expect(nvm.permissions.deny).toContain("Read(//home/a/.*/**)");
  const sys = factorySettings({ HOME: "/home/a", UV_PYTHON_INSTALL_DIR: "/opt/uv-python" }, "/opt/hooks", "/w/run/target", undefined, false, "linux", [], "/usr/local/bin/node");
  expect(sys.sandbox.filesystem.allowRead).toBeUndefined();
});

test("uv's Python dir under HOME is readable in the sandbox, since a target's .venv/bin/python links into it", () => {
  const s = factorySettings({ HOME: "/home/a" }, "/opt/hooks", "/w/run/target", undefined, false, "linux", [], "/usr/local/bin/node");
  expect(s.sandbox.filesystem.allowRead).toEqual(["/home/a/.local/share/uv/python"]);
});

test("Chromium under HOME is readable in the sandbox: the browsers dir and, on macOS, the default dir its links point to", () => {
  const s = factorySettings({ HOME: "/home/a", PLAYWRIGHT_BROWSERS_PATH: "/home/a/Library/Caches/ms-playwright-sandbox" }, "/opt/hooks", "/w/run/target", undefined, true, "darwin", [], "/usr/local/bin/node");
  expect(s.sandbox.filesystem.allowRead).toEqual(["/home/a/Library/Caches/ms-playwright-sandbox", "/home/a/Library/Caches/ms-playwright", "/home/a/.local/share/uv/python"]);
});

test("a code agent keeps npm's and uv's caches in the clone's run dir; an agent without tools gets no extra variable", () => {
  expect(codeEnv({ tools: "code" }, "/w/run/target", {})).toEqual({ npm_config_cache: "/w/run/target/run/npm-cache", UV_CACHE_DIR: "/w/run/target/run/uv-cache", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
  expect(codeEnv({ tools: "none" }, "/tmp/empty", {})).toEqual({});
});

test("on a local run the agent reads the Mac's Corepack cache, since Corepack cannot download pnpm through the sandbox", () => {
  const local = { HOME: "/home/a", FACTORY_PNPM_STORE: "/w/pnpm-store" };
  expect(codeEnv({ tools: "code" }, "/w/run/target", local).COREPACK_HOME).toBe("/home/a/.cache/node/corepack");
  expect(factorySettings(local, "/opt/hooks", "/w/run/target", undefined, false, "linux", [], "/usr/local/bin/node").sandbox.filesystem.allowRead).toContain("/home/a/.cache/node/corepack");
  expect(codeEnv({ tools: "code" }, "/w/run/target", { HOME: "/home/a" })).not.toHaveProperty("COREPACK_HOME"); // CI: Corepack keeps its own cache
});

test("on macOS the agent may open unix sockets in Claude Code's per-user TMPDIR too", () => {
  const mac = factorySettings({}, "/opt/hooks", "/w/run/target", undefined, false, "darwin", [], "/usr/bin/node", 501).sandbox.network;
  expect(mac.allowUnixSockets).toEqual(["/tmp/claude", "/private/tmp/claude", "/tmp/claude-501", "/private/tmp/claude-501"]);
});

test("the agent may read the factory checkout around its clone, but none of what git ignores there", () => {
  const s = withRootReads(factorySettings({}, "/opt/hooks", "/w/run/target"), { allowRead: ["/w"], denyRead: ["/w/.env", "/w/.cache"] });
  expect(s.sandbox.filesystem.allowRead).toContain("/w");
  expect(s.sandbox.filesystem.denyRead).toEqual(expect.arrayContaining(["/w/.env", "/w/.cache", "/proc"]));
});
test("rootReads denies this checkout's ignored files, keeps run/ readable, and allows nothing without git", () => {
  const r = rootReads();
  expect(r.allowRead).toHaveLength(1);
  expect(r.denyRead.some((p) => p.endsWith("/.cache"))).toBe(true);
  expect(r.denyRead.some((p) => p.endsWith("/run"))).toBe(false);
  expect(rootReads("/")).toEqual({ allowRead: [], denyRead: [] });
});
