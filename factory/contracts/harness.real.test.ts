import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { claudeCode } from "../adapters/claude-code";
import { pi, piSandboxSettings } from "../adapters/pi";
import { piHome } from "../sandbox";
import type { Provider } from "../seams";
import { harnessContract } from "./harness.contract";

// Manual job only (contract-real in .gitlab-ci.yml): it makes real model calls.
// Claude Code needs CLAUDE_CODE_OAUTH_TOKEN. Pi needs TENSORX_API_KEY and CONTRACT_PI_MODEL (a model TensorX serves).
const teamPlan: Provider = { name: "team-plan", api: "anthropic", keyEnv: "CLAUDE_CODE_OAUTH_TOKEN", models: { "claude-sonnet-5-5": "claude" } };
const tensorx: Provider = { name: "tensorx", api: "openai", baseUrl: "https://api.tensorx.ai/v1", keyEnv: "TENSORX_API_KEY", models: {} };

describe.skipIf(!process.env.FACTORY_CONTRACT_REAL)("real Claude Code harness", () => {
  harnessContract(() => claudeCode, { model: { provider: teamPlan, model: "claude-sonnet-5-5", effort: "medium" }, unserved: { provider: teamPlan, model: "no-such-model" } });
});

describe.skipIf(!process.env.FACTORY_CONTRACT_REAL)("real Pi harness", () => {
  // The callback also runs when the suite is skipped, so only fail when the real run is on.
  const model = process.env.CONTRACT_PI_MODEL ?? "";
  if (process.env.FACTORY_CONTRACT_REAL && !model) throw new Error("CONTRACT_PI_MODEL is not set");
  harnessContract(() => pi, { model: { provider: tensorx, model }, unserved: { provider: tensorx, model: "no-such-model" }, author: false });
  // The model must be one that reads images. Run it with CONTRACT_PI_MODEL set to the model to prove.
  test("the reviewer model reads an image", async () => {
    const red = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC", "base64"); // 8x8, solid red
    const r = await pi.run({ role: "reviewer", prompt: "What is the main color of the image? Answer with one word.", model: { provider: { ...tensorx, models: { [model]: "x" }, images: [model] }, model }, cwd: tmpdir(), tools: "none", maxTurns: 1, images: [{ name: "red.png", data: red }] });
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/red/i);
  }, 120_000);
});

// Sandbox proof: srt with the Pi author settings. Needs a working srt (not inside another sandbox), no model call.
describe.skipIf(!process.env.FACTORY_CONTRACT_REAL)("pi author sandbox", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
  const srt = `${root}/node_modules/.bin/srt`;
  const run = (cmd: string) => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-sandbox-")));
    const cwd = join(base, "target");
    mkdirSync(cwd);
    mkdirSync(piHome(cwd));
    writeFileSync(join(piHome(cwd), "marker"), "session");
    const settings = join(base, "srt-settings.json");
    writeFileSync(settings, JSON.stringify(piSandboxSettings(cwd, piHome(cwd), tensorx)));
    return spawnSync(srt, ["--settings", settings, "-c", cmd.replaceAll("<pi-home>", piHome(cwd))], { cwd, env: { PATH: process.env.PATH, HOME: piHome(cwd) } }).status;
  };
  test("sandbox: the factory checkout's .git is not readable", () => expect(run(`cat ${root}/.git/config`)).not.toBe(0));
  test("sandbox: a host that is not allowed cannot be reached", () => expect(run(`node -e "fetch('https://example.com').then(()=>process.exit(0),()=>process.exit(1))"`)).not.toBe(0));
  test("sandbox: pi can still read its own home", () => expect(run("cat <pi-home>/marker")).toBe(0));
});
