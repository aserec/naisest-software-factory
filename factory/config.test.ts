import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { loadRouter, loadSeams, loadTarget, modelChoice, parseFactoryFile } from "./config";

const real = (name: string) => readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8");
// The real file with one text replaced, in a temp dir.
const edited = (name: string, from: string | RegExp, to: string) => {
  const text = real(name);
  const out = text.replace(from, to);
  if (out === text) throw new Error(`test setup: ${from} not found in ${name}`);
  const path = join(mkdtempSync(join(tmpdir(), "config-")), name);
  writeFileSync(path, out);
  return path;
};

test("router.yml gives the spec's models and bump", () => {
  const r = loadRouter();
  expect(r.low).toMatchObject({ author: { harness: "claude-code", provider: "team-plan", model: "claude-sonnet-5-5", effort: "medium" }, reviewer: { harness: "pi", provider: "tensorx" }, mayAutoMerge: true });
  expect(r.high).toMatchObject({ author: { model: "claude-opus-5-5", effort: "high" }, mayAutoMerge: false });
  expect(r.writer).toMatchObject({ harness: "claude-code", provider: "team-plan" });
  expect(r.effortBump).toBe(8);
});
test("seams.yml picks the GitLab, Jev and Teams adapters and gives the providers to the harness", () => {
  const s = loadSeams();
  expect(s).toMatchObject({ tracker: "gitlab", codeHost: "gitlab", ci: "gitlab", judge: "jev-berget", chat: "teams", logSource: "files" });
  expect(modelChoice(loadRouter().low.reviewer, s)).toEqual({
    provider: { name: "tensorx", api: "openai", baseUrl: "https://api.tensorx.ai/v1", keyEnv: "TENSORX_API_KEY", models: { "tensorx-deepseek-small": "deepseek", "tensorx-deepseek-large": "deepseek" } },
    model: "tensorx-deepseek-small",
    effort: undefined,
  });
});
test("a role with an unknown provider or a model its provider does not list is refused", () => {
  expect(() => loadRouter(edited("router.yml", "provider: tensorx, model: tensorx-deepseek-small", "provider: openrouter, model: tensorx-deepseek-small"))).toThrow("router.yml low.reviewer: unknown provider openrouter");
  expect(() => loadRouter(edited("router.yml", "model: tensorx-deepseek-large", "model: gpt-9"))).toThrow("router.yml high.reviewer: provider tensorx has no model gpt-9");
  expect(() => loadRouter(edited("router.yml", /writer: \{ harness: claude-code, provider: team-plan, model: claude-sonnet-5-5/, "writer: { harness: claude-code, provider: team-plan, model: nope"))).toThrow("router.yml writer: provider team-plan has no model nope");
});
test("a harness that cannot use the provider's api is refused", () => {
  expect(() => loadRouter(edited("router.yml", "reviewer: { harness: pi, provider: tensorx, model: tensorx-deepseek-small", "reviewer: { harness: claude-code, provider: tensorx, model: tensorx-deepseek-small"))).toThrow("router.yml low.reviewer: harness claude-code cannot use the openai api of provider tensorx");
});
test("the Team plan works only with claude-code, and never for the judge", () => {
  expect(() => loadRouter(edited("router.yml", "reviewer: { harness: pi, provider: tensorx, model: tensorx-deepseek-small", "reviewer: { harness: pi, provider: team-plan, model: claude-sonnet-5-5"))).toThrow("router.yml low.reviewer: harness pi with provider team-plan: the Team plan works only with claude-code");
  expect(() => loadSeams(edited("seams.yml", "judgeModel: { provider: tensorx, model: tensorx-deepseek-small }", "judgeModel: { provider: team-plan, model: claude-sonnet-5-5 }"))).toThrow("seams.yml judgeModel: provider team-plan: the Team plan works only with claude-code");
  expect(() => loadSeams(edited("seams.yml", "judgeModel: { provider: tensorx, model: tensorx-deepseek-small }", "judgeModel: { provider: tensorx, model: nope }"))).toThrow("seams.yml judgeModel: provider tensorx has no model nope");
});
test("one row's author and reviewer may not share a model family", () => {
  const seams = loadSeams(edited("seams.yml", "tensorx-deepseek-small: deepseek,", "tensorx-deepseek-small: claude,"));
  expect(() => loadRouter(undefined, seams)).toThrow("router.yml low: author and reviewer are both family claude");
});
test("a seams.yml field of the wrong shape names the field", () => {
  expect(() => loadSeams(edited("seams.yml", "api: openai", "api: grpc"))).toThrow(/seams\.yml: providers\.tensorx\.api/);
});
test("react_frontend target has the 300-line limit and the protected paths", () => {
  const t = loadTarget("react_frontend", { defaultApprover: "approver" });
  expect(t.maxChangedLines).toBe(300);
  expect(t.protectedPaths).toEqual(expect.arrayContaining([".gitlab-ci.yml", ".factory.yml", "CLAUDE.md", "AGENTS.md", ".claude/**", ".agents/**", "**/Dockerfile*"]));
});
test(".factory.yml without build is rejected", () => {
  expect(() => parseFactoryFile("lint: pnpm lint\ntest: pnpm test")).toThrow(/build/);
});
test(".factory.yml without install is rejected", () => {
  expect(() => parseFactoryFile("lint: pnpm lint\ntest: pnpm test\nbuild: pnpm build")).toThrow(/install/);
  expect(parseFactoryFile("install: pnpm install --frozen-lockfile\nlint: a\ntest: b\nbuild: c").install).toBe("pnpm install --frozen-lockfile");
});
test("a target with a REPLACE_WITH_ placeholder is refused with a clear error", () => {
  expect(() => loadTarget("react_frontend")).toThrow(/targets\/react_frontend\.yml: defaultApprover is still a placeholder/);
  expect(loadTarget("react_frontend", { defaultApprover: "kirill" }).defaultApprover).toBe("kirill");
});
