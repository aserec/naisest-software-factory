import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { HarnessJob, Provider } from "../seams";
import { sandboxDenyRead } from "../sandbox";
import { agentEnv, pi, piArgs, piModels, piSandboxSettings, piToolCalls } from "./pi";
import { readNew } from "../inbox-file";
import piExtension, { guardCheck } from "./pi-extension";

// The harness runs srt by absolute path, so the fake srt replaces that path here.
const fake = vi.hoisted(() => ({ srt: "" }));
vi.mock("../srt", async (orig) => {
  const real: any = await orig();
  return { ...real, get SRT() { return fake.srt || real.SRT; } };
});

const tensorx: Provider = { name: "tensorx", api: "openai", baseUrl: "https://t.example/v1", keyEnv: "TENSORX_API_KEY", models: { m1: "other" } };
const anthropic: Provider = { name: "gw", api: "anthropic", baseUrl: "https://gw.example", keyEnv: "GW_KEY", models: { m1: "claude" } };

test("Pi gets the job's provider as the only provider", () => {
  const m = piModels({ provider: tensorx, model: "m1" });
  expect(Object.keys(m.providers)).toEqual(["tensorx"]);
  expect(m.providers.tensorx).toMatchObject({ baseUrl: "https://t.example/v1", api: "openai-completions", apiKey: "$TENSORX_API_KEY", models: [{ id: "m1" }] });
});
test("an anthropic provider uses anthropic-messages", () => expect(piModels({ provider: anthropic, model: "m1" }).providers.gw.api).toBe("anthropic-messages"));
test("Pi runs with no tools and loads nothing from the cwd", () => {
  const args = piArgs("tensorx", "m1", "-review this");
  expect(args).toEqual(expect.arrayContaining(["--print", "--no-tools", "--no-session", "--no-extensions", "--no-context-files", "--no-mcp", "--no-approve", "--provider", "tensorx"]));
  expect(args.slice(-2)).toEqual(["--", "-review this"]); // a prompt starting with "-" is not read as a flag
});
test("Pi gets the image files before the prompt", () => expect(piArgs("tensorx", "m", "p", ["/t/a.png"]).slice(-3)).toEqual(["--", "@/t/a.png", "p"]));
test("a model that reads images gets image input in models.json", () => {
  expect(piModels({ provider: { ...tensorx, images: ["m1"] }, model: "m1" }).providers.tensorx.models[0].input).toEqual(["text", "image"]);
  expect(piModels({ provider: tensorx, model: "m1" }).providers.tensorx.models[0].input ?? []).not.toContain("image");
});
test("a model with a price gets it as cost in models.json, so Pi reports what a run costs", () => {
  const price = { input: 0.5, output: 1.5, cacheRead: 0.13, cacheWrite: 0 };
  expect(piModels({ provider: { ...tensorx, prices: { m1: price } }, model: "m1" }).providers.tensorx.models[0].cost).toEqual(price);
  expect(piModels({ provider: tensorx, model: "m1" }).providers.tensorx.models[0].cost).toBeUndefined();
});
test("Pi env holds only the allowed keys and the provider key", () => {
  const e = agentEnv({ PATH: "/bin", HOME: "/h", FACTORY_GITLAB_TOKEN: "g", TEAMS_WEBHOOK_URL: "w", BERGET_API_KEY: "b", CLAUDE_CODE_OAUTH_TOKEN: "t", TENSORX_API_KEY: "k" }, tensorx, "/tmp/d");
  expect(e).toEqual({ PATH: "/bin", HOME: "/tmp/d", PI_CODING_AGENT_DIR: "/tmp/d", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", TENSORX_API_KEY: "k" });
  expect(Object.keys(e).sort()).toEqual(["HOME", "PATH", "PI_CODING_AGENT_DIR", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY", "TENSORX_API_KEY"]);
});

test("Pi env keeps the browser path when it is set", () => {
  const e = agentEnv({ PATH: "/bin", PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright", TENSORX_API_KEY: "k" }, tensorx, "/tmp/d");
  expect(e.PLAYWRIGHT_BROWSERS_PATH).toBe("/ms-playwright");
});

// --- the harness itself, against a fake `pi` program on PATH ---
const origPath = process.env.PATH;
afterEach(() => { process.env.PATH = origPath; fake.srt = ""; vi.unstubAllEnvs(); });

// Puts a `pi` script first on PATH. It records args, cwd, env and models.json, then runs `body`.
function fakePi(body: string) {
  const bin = realpathSync(mkdtempSync(join(tmpdir(), "fake-pi-")));
  const script = join(bin, "pi");
  writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$@" > "${bin}/args"\npwd > "${bin}/cwd"\nenv > "${bin}/env"\ncp "$PI_CODING_AGENT_DIR/models.json" "${bin}/models.json"\n${body}\n`);
  chmodSync(script, 0o755);
  process.env.PATH = `${bin}:${origPath}`;
  return bin;
}
const job = (over: Partial<HarnessJob> = {}): HarnessJob => ({ role: "reviewer", prompt: "review it", model: { provider: tensorx, model: "m1" }, cwd: realpathSync(tmpdir()), tools: "none", maxTurns: 1, ...over });

test("a no-tools job returns stdout as text, from an empty dir with the provider's config", async () => {
  const bin = fakePi("echo hello");
  vi.stubEnv("TENSORX_API_KEY", "tx-key");
  vi.stubEnv("FACTORY_GITLAB_TOKEN", "gl-secret");
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "oauth-secret");
  const r = await pi.run(job());
  expect(r).toEqual({ session: "", ok: true, limitHit: false, stopped: false, costUsd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextTokens: 0, text: "hello\n" });
  expect(readFileSync(join(bin, "cwd"), "utf8").trim()).not.toBe(realpathSync(tmpdir()));
  expect(readFileSync(join(bin, "args"), "utf8")).toContain("--provider\ntensorx\n--model\nm1");
  expect(JSON.parse(readFileSync(join(bin, "models.json"), "utf8")).providers.tensorx.api).toBe("openai-completions");
  const env = readFileSync(join(bin, "env"), "utf8");
  expect(env).toContain("TENSORX_API_KEY=tx-key");
  expect(env).not.toMatch(/gl-secret|oauth-secret/);
});

test("a reviewer job passes its images to Pi as files with the same bytes", async () => {
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const bin = fakePi(`for a in "$@"; do case "$a" in @*) wc -c < "\${a#@}" > "$(dirname "$0")/sizes";; esac; done`);
  await pi.run(job({ images: [{ name: "after-list-1280.png", data: PNG }] }));
  expect(readFileSync(join(bin, "args"), "utf8").split("\n")).toEqual(expect.arrayContaining([expect.stringMatching(/^@.*\/after-list-1280\.png$/)]));
  expect(Number(readFileSync(join(bin, "sizes"), "utf8"))).toBe(PNG.length);
});

test("an anthropic provider writes anthropic-messages to models.json", async () => {
  const bin = fakePi("echo x");
  await pi.run(job({ model: { provider: anthropic, model: "m1" } }));
  expect(JSON.parse(readFileSync(join(bin, "models.json"), "utf8")).providers.gw.api).toBe("anthropic-messages");
});

test("a pi that exits 1 with no output is a failed run that names the exit code and stderr, not a throw", async () => {
  fakePi("echo 'no API key' >&2\nexit 1");
  const r = await pi.run(job());
  expect(r).toMatchObject({ ok: false, limitHit: false });
  expect(r.text).toBe("Pi exited with code 1. The end of its error output:\nno API key");
});

// --- the author path: `pi` runs inside `srt` (a fake srt that runs the command, so quoting is tested too) ---
function fakeSrt() {
  const bin = realpathSync(mkdtempSync(join(tmpdir(), "fake-srt-")));
  const script = join(bin, "srt");
  writeFileSync(script, `#!/bin/sh\ncp "$2" "${bin}/settings.json"\nprintf '%s' "$4" > "${bin}/cmd"\nexec sh -c "$4"\n`);
  chmodSync(script, 0o755);
  fake.srt = script;
  return bin;
}
// run/target and its sibling run/pi-home, like a real run.
const runDir = () => { const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-run-"))); mkdirSync(join(root, "target")); return join(root, "target"); };
const authorJob = (cwd: string, over: Partial<HarnessJob> = {}) => job({ role: "author", tools: "code", cwd, maxTurns: 5, ...over });
const events = (...e: object[]) => `printf '%s\\n' '${e.map((x) => JSON.stringify(x)).join("\n")}'`;
const header = { type: "session", id: "sess-1" };
const answer = (text: string, usage = { input: 10, output: 3, cost: { total: 0.02 } }) => ({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage } });

test("the guard blocks rm -rf / and allows pnpm test", () => {
  expect(guardCheck("rm -rf /").block).toBe(true);
  expect(guardCheck("rm -rf /").reason).toBeTruthy();
  expect(guardCheck("pnpm test")).toEqual({ block: false });
});
test("the guard fails closed when it cannot run", () => expect(guardCheck("ls", "/no/such/dir").block).toBe(true));

test("pi sandbox settings: the shared read denies, the provider host, writes only to the clone and the pi home", () => {
  const s: any = piSandboxSettings("/w/run/target", "/w/run/pi-home", tensorx);
  expect(s.filesystem.denyRead).toEqual(sandboxDenyRead("/w/run/target"));
  expect(s.filesystem.denyRead).toContain("/w/run/pi-home");
  expect(s.filesystem.allowRead).toEqual(["/w/run/pi-home"]); // pi must read its own sessions
  expect(s.filesystem.allowWrite).toEqual(["/w/run/target", "/w/run/pi-home", "/tmp"]);
  expect(s.network.allowedDomains).toContain("t.example");
  expect(s.network.allowedDomains).toContain("registry.npmjs.org");
});
test("pi sandbox settings: the preview flag allows local binding", () => {
  vi.stubEnv("FACTORY_PNPM_STORE", ""); // unset: the store case stays off
  expect((piSandboxSettings("/w/run/target", "/w/run/pi-home", tensorx, true) as any).network.allowLocalBinding).toBe(true);
  expect((piSandboxSettings("/w/run/target", "/w/run/pi-home", tensorx, false) as any).network.allowLocalBinding).toBeUndefined();
});
test("a provider with no base URL adds no host", () => {
  const s: any = piSandboxSettings("/w/run/target", "/w/run/pi-home", { ...tensorx, baseUrl: undefined });
  expect(s.network.allowedDomains).not.toContain(undefined);
  expect(s.network.allowedDomains).toEqual((piSandboxSettings("/w/run/target", "/w/run/pi-home", tensorx) as any).network.allowedDomains.filter((d: string) => d !== "t.example"));
});

test("an author job runs pi in srt with the guard extension, the sandbox settings and a session", async () => {
  const bin = fakePi(events(header, answer("done")));
  const srt = fakeSrt();
  vi.stubEnv("TENSORX_API_KEY", "tx-key");
  const cwd = runDir();
  const r = await pi.run(authorJob(cwd, { prompt: "fix 'it'; $(x)" }));
  expect(r).toEqual({ session: "sess-1", ok: true, limitHit: false, stopped: false, costUsd: 0.02, tokens: { input: 10, output: 3, cacheRead: 0, cacheWrite: 0 }, contextTokens: 10, text: "done" });
  const args = readFileSync(join(bin, "args"), "utf8").split("\n");
  expect(args).toEqual(expect.arrayContaining(["--print", "--mode", "json", "--no-extensions", "--extension", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-mcp", "--provider", "tensorx", "--model", "m1"]));
  expect(args).not.toContain("--no-tools");
  expect(args).not.toContain("--continue");
  expect(args[args.indexOf("--extension") + 1]).toMatch(/^\/.*pi-extension\.ts$/); // absolute
  expect(args[args.indexOf("--") + 1]).toBe("fix 'it'; $(x)"); // quoting keeps the prompt whole
  expect(readFileSync(join(bin, "cwd"), "utf8").trim()).toBe(cwd);
  const home = join(cwd, "..", "pi-home");
  expect(JSON.parse(readFileSync(join(home, "models.json"), "utf8")).providers.tensorx.models).toEqual([{ id: "m1" }]);
  expect(readFileSync(join(bin, "env"), "utf8")).toContain(`PI_CODING_AGENT_DIR=${realpathSync(home)}`);
  const settings = JSON.parse(readFileSync(join(srt, "settings.json"), "utf8"));
  expect(settings.filesystem.denyRead).toEqual(sandboxDenyRead(cwd));
  expect(settings.network.allowedDomains).toContain("t.example");
});

test("a resume continues the session kept in the pi home", async () => {
  const bin = fakePi(events(header, answer("again")));
  fakeSrt();
  const cwd = runDir();
  await pi.run(authorJob(cwd, { resume: "sess-1" }));
  const args = readFileSync(join(bin, "args"), "utf8").split("\n");
  expect(args).toContain("--continue");
  expect(args).not.toContain("--session"); // Pi 1.4.0 reads --session as a file: a directory fails with EISDIR
});

test("a provider 429 in the output is a limit hit", async () => {
  fakePi(`${events(header, { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "429 Too Many Requests: quota exceeded" } })}\nexit 1`);
  fakeSrt();
  expect(await pi.run(authorJob(runDir()))).toMatchObject({ ok: false, limitHit: true });
});

// Pi retries a dropped connection itself. Only the last assistant message says how the run ended.
test("an error that Pi retried past is not a failed run", async () => {
  fakePi(events(header, { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "429 Connection error." } }, answer("done")));
  fakeSrt();
  expect(await pi.run(authorJob(runDir()))).toMatchObject({ ok: true, limitHit: false, text: "done" });
});

test("a model that is not served is a failed run, not a limit", async () => {
  fakePi(`${events(header, { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "404 model not found" } })}\nexit 1`);
  fakeSrt();
  expect(await pi.run(authorJob(runDir()))).toMatchObject({ ok: false, limitHit: false });
});

test("a pi cut in the middle of a JSON line is a failed run, not a throw and not a limit", async () => {
  fakePi(`printf '%s\\n' '${JSON.stringify(header)}'\nprintf '{"type":"message_end","mess'\nexit 1`);
  fakeSrt();
  expect(await pi.run(authorJob(runDir()))).toMatchObject({ ok: false, limitHit: false });
});

test("an author run that fails before Pi writes a message names the exit code and stderr", async () => {
  fakePi(`${events(header)}\necho 'srt: sandbox refused' >&2\nexit 2`);
  fakeSrt();
  const r = await pi.run(authorJob(runDir()));
  expect(r).toMatchObject({ ok: false, limitHit: false });
  expect(r.text).toBe("Pi exited with code 2. The end of its error output:\nsrt: sandbox refused");
});

test("an author job also checks the command guard before anything starts", async () => {
  const bin = fakePi("echo x");
  fakeSrt();
  process.env.PATH = bin; // fake pi only: no jq
  await expect(pi.run(authorJob(runDir()))).rejects.toThrow(/jq/);
  expect(existsSync(join(bin, "args"))).toBe(false);
});

test("the harness refuses to start when the command guard cannot run, and never starts pi", async () => {
  const bin = fakePi("echo x");
  process.env.PATH = bin; // fake pi only: no jq, so the guard cannot run
  await expect(pi.run(job())).rejects.toThrow(/jq/);
  expect(() => readFileSync(join(bin, "args"))).toThrow();
});

// The inbox.
test("a stop in the inbox gives stopped and not ok, and the poll is written to the inbox file in the pi home", async () => {
  fakePi(events(header, answer("done")));
  fakeSrt();
  const cwd = runDir();
  const r = await pi.run(authorJob(cwd, { inbox: { poll: async () => ({ comments: ["c1"], stop: true }) } }));
  expect(r).toMatchObject({ ok: false, stopped: true, session: "sess-1" });
  expect(JSON.parse(readFileSync(join(cwd, "..", "pi-home", "inbox.jsonl"), "utf8"))).toEqual({ comments: ["c1"], stop: true });
});
test("a run starts with an empty inbox: a file from an earlier run is removed", async () => {
  fakePi(events(header, answer("done")));
  fakeSrt();
  const cwd = runDir();
  const home = join(cwd, "..", "pi-home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "inbox.jsonl"), '{"comments":[],"stop":true}\n');
  expect(await pi.run(authorJob(cwd))).toMatchObject({ ok: true, stopped: false });
  expect(existsSync(join(home, "inbox.jsonl"))).toBe(false);
});
function extensionWith(file: string) {
  vi.stubEnv("PI_CODING_AGENT_DIR", join(file, ".."));
  const handlers: Record<string, (e: any, ctx?: any) => unknown> = {};
  const sent: any[] = [];
  piExtension({ on: (name, h) => void (handlers[name] = h), sendMessage: (m, o) => void sent.push([m, o]) });
  const ctx = { aborted: false, abort() { ctx.aborted = true; } };
  return { result: () => handlers.tool_result({}, ctx), sent, ctx };
}
test("the extension hands new comments to the agent after a tool result, once", () => {
  const file = join(mkdtempSync(join(tmpdir(), "ext-")), "inbox.jsonl");
  writeFileSync(file, '{"comments":["c1","c2"],"stop":false}\n');
  const x = extensionWith(file);
  x.result();
  x.result();
  expect(x.sent).toHaveLength(1);
  expect(x.sent[0][0].content).toBe("c1\n\nc2");
  expect(x.sent[0][1]).toEqual({ deliverAs: "steer" });
  expect(x.ctx.aborted).toBe(false);
});
test("a stop with no ctx.abort() says so on stderr instead of doing nothing silently", () => {
  const file = join(mkdtempSync(join(tmpdir(), "ext-")), "inbox.jsonl");
  writeFileSync(file, '{"comments":[],"stop":true}\n');
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("PI_CODING_AGENT_DIR", join(file, ".."));
  const handlers: Record<string, (e: any, ctx?: any) => unknown> = {};
  piExtension({ on: (name, h) => void (handlers[name] = h) });
  handlers.tool_result({}, {});
  expect(err).toHaveBeenCalledWith(expect.stringContaining("no ctx.abort()"));
  err.mockRestore();
});
test("the extension aborts the agent on a stop line, and does nothing without an inbox file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ext-"));
  const none = extensionWith(join(dir, "inbox.jsonl"));
  none.result();
  expect(none.sent).toHaveLength(0);
  writeFileSync(join(dir, "inbox.jsonl"), '{"comments":[],"stop":true}\n');
  const x = extensionWith(join(dir, "inbox.jsonl"));
  x.result();
  expect(x.ctx.aborted).toBe(true);
  expect(readNew(join(dir, "inbox.jsonl"))).toEqual({ comments: [], stop: false });
});

// Live tool calls. Event names are from the Pi JSON mode docs (docs/json.md): tool_execution_start and tool_execution_end.
const toolStart = (id: string, toolName: string, args: object) => ({ type: "tool_execution_start", toolCallId: id, toolName, args });
const toolEnd = (id: string, toolName: string, text: string, isError = false, durationMs = 42) => ({ type: "tool_execution_end", toolCallId: id, toolName, result: { content: [{ type: "text", text }], details: {} }, isError, durationMs });
test("piToolCalls pairs a tool start and end by id, takes the time Pi measured, and gives ok from isError", () => {
  const calls = piToolCalls();
  const got = [toolStart("c1", "read", { path: "a.ts" }), toolEnd("c1", "read", "file text"), toolStart("c2", "bash", { command: "pnpm test" }), toolEnd("c2", "bash", "1 failed", true, 7)]
    .flatMap((e) => calls.line(JSON.stringify(e)));
  expect(got).toEqual([
    { name: "read", input: JSON.stringify({ path: "a.ts" }), result: "file text", ms: 42, ok: true },
    { name: "bash", input: JSON.stringify({ command: "pnpm test" }), result: "1 failed", ms: 7, ok: false },
  ]);
});
test("piToolCalls ignores other events, a line that is not JSON and an end with no start", () => {
  const calls = piToolCalls();
  expect([calls.line("not json"), calls.line(JSON.stringify({ type: "turn_start" })), calls.line(JSON.stringify(toolEnd("zz", "bash", "x")))]).toEqual([[], [], []]);
});
test("an author job gives each tool call to onToolCall while pi runs, and the cache and context tokens in the result", async () => {
  const usage = { input: 10, output: 3, cacheRead: 100, cacheWrite: 20, cost: { total: 0.02 } };
  fakePi(events(header, toolStart("c1", "bash", { command: "ls" }), toolEnd("c1", "bash", "a.ts"), answer("done", usage)));
  fakeSrt();
  const seen: string[] = [];
  const r = await pi.run(authorJob(runDir(), { onToolCall: (c) => seen.push(`${c.name}:${c.result}:${c.ok}`) }));
  expect(seen).toEqual(["bash:a.ts:true"]);
  expect(r).toMatchObject({ ok: true, tokens: { input: 10, output: 3, cacheRead: 100, cacheWrite: 20 }, contextTokens: 130 });
});
