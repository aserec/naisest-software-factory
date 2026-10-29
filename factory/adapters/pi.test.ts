import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { HarnessJob, Provider } from "../seams";
import { agentEnv, pi, piArgs, piModels } from "./pi";

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
test("Pi env holds only the allowed keys and the provider key", () => {
  const e = agentEnv({ PATH: "/bin", HOME: "/h", FACTORY_GITLAB_TOKEN: "g", TEAMS_WEBHOOK_URL: "w", BERGET_API_KEY: "b", CLAUDE_CODE_OAUTH_TOKEN: "t", TENSORX_API_KEY: "k" }, tensorx, "/tmp/d");
  expect(e).toEqual({ PATH: "/bin", HOME: "/tmp/d", PI_CODING_AGENT_DIR: "/tmp/d", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", TENSORX_API_KEY: "k" });
  expect(Object.keys(e).sort()).toEqual(["HOME", "PATH", "PI_CODING_AGENT_DIR", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY", "TENSORX_API_KEY"]);
});

// --- the harness itself, against a fake `pi` program on PATH ---
const origPath = process.env.PATH;
afterEach(() => { process.env.PATH = origPath; vi.unstubAllEnvs(); });

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
  expect(r).toEqual({ session: "", ok: true, limitHit: false, stopped: false, costUsd: 0, tokens: { input: 0, output: 0 }, text: "hello\n" });
  expect(readFileSync(join(bin, "cwd"), "utf8").trim()).not.toBe(realpathSync(tmpdir()));
  expect(readFileSync(join(bin, "args"), "utf8")).toContain("--provider\ntensorx\n--model\nm1");
  expect(JSON.parse(readFileSync(join(bin, "models.json"), "utf8")).providers.tensorx.api).toBe("openai-completions");
  const env = readFileSync(join(bin, "env"), "utf8");
  expect(env).toContain("TENSORX_API_KEY=tx-key");
  expect(env).not.toMatch(/gl-secret|oauth-secret/);
});

test("an anthropic provider writes anthropic-messages to models.json", async () => {
  const bin = fakePi("echo x");
  await pi.run(job({ model: { provider: anthropic, model: "m1" } }));
  expect(JSON.parse(readFileSync(join(bin, "models.json"), "utf8")).providers.gw.api).toBe("anthropic-messages");
});

test("a pi that exits 1 with no output is a failed run, not a throw", async () => {
  fakePi("exit 1");
  expect(await pi.run(job())).toMatchObject({ ok: false, limitHit: false, text: "" });
});

test("a pi author job needs the sandbox", async () => {
  const bin = fakePi("echo x");
  await expect(pi.run(job({ role: "author", tools: "code" }))).rejects.toThrow("Pi author needs the sandbox");
  expect(() => readFileSync(join(bin, "args"))).toThrow(); // pi was never started
});

test("the harness refuses to start when the command guard cannot run, and never starts pi", async () => {
  const bin = fakePi("echo x");
  process.env.PATH = bin; // fake pi only: no jq, so the guard cannot run
  await expect(pi.run(job())).rejects.toThrow(/jq/);
  expect(() => readFileSync(join(bin, "args"))).toThrow();
});
