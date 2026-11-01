import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { checkDashboardUrl, loadRouter, loadSeams, loadTarget, modelChoice, parseFactoryFile } from "./config";

const real = (name: string) => readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8");
// The real file with one text replaced, in a temp dir.
const edited = (name: string, from: string | RegExp, to: string) => {
  const text = real(name);
  if (!(typeof from === "string" ? text.includes(from) : from.test(text))) throw new Error(`test setup: ${from} not found in ${name}`);
  const path = join(mkdtempSync(join(tmpdir(), "config-")), name);
  writeFileSync(path, text.replace(from, to));
  return path;
};

test("router.yml gives the spec's models and bump", () => {
  const r = loadRouter();
  expect(r.low).toMatchObject({ author: { harness: "pi", provider: "tensorx", model: "deepseek/deepseek-v4.1-flash-1017" }, reviewer: { harness: "pi", provider: "tensorx", model: "z-ai/glm-5.3-flash" }, mayAutoMerge: true });
  expect(r.high).toMatchObject({ author: { model: "deepseek/deepseek-v4.1-flash-1017" }, mayAutoMerge: false });
  expect(r.writer).toMatchObject({ harness: "pi", provider: "tensorx" });
  expect(r.effortBump).toBe(8);
});
test("seams.yml picks the GitLab, model judge and console adapters and gives the providers to the harness", () => {
  const s = loadSeams();
  expect(s).toMatchObject({ tracker: "gitlab", codeHost: "gitlab", ci: "gitlab", judge: "model-call", chat: "console", logSource: "files", dashboard: "http" });
  expect(modelChoice(loadRouter().low.reviewer, s)).toEqual({
    provider: { name: "tensorx", api: "openai", baseUrl: "https://api.tensorx.ai/v1", keyEnv: "TENSORX_API_KEY", models: { "deepseek/deepseek-v4.1-flash-1017": "deepseek", "z-ai/glm-5.3-flash": "glm" } },
    model: "z-ai/glm-5.3-flash",
    effort: undefined,
  });
});
test("a role with an unknown provider or a model its provider does not list is refused", () => {
  expect(() => loadRouter(edited("router.yml", "provider: tensorx, model: z-ai/glm-5.3-flash", "provider: openrouter, model: z-ai/glm-5.3-flash"))).toThrow("router.yml low.reviewer: unknown provider openrouter");
  expect(() => loadRouter(edited("router.yml", /(high:[\s\S]*?reviewer: [^}]*model: )z-ai\/glm-5\.3-flash/, "$1gpt-9"))).toThrow("router.yml high.reviewer: provider tensorx has no model gpt-9");
  expect(() => loadRouter(edited("router.yml", "writer: { harness: pi, provider: tensorx, model: deepseek/deepseek-v4.1-flash-1017", "writer: { harness: pi, provider: tensorx, model: nope"))).toThrow("router.yml writer: provider tensorx has no model nope");
});
test("a harness that cannot use the provider's api is refused", () => {
  expect(() => loadRouter(edited("router.yml", "reviewer: { harness: pi, provider: tensorx, model: z-ai/glm-5.3-flash", "reviewer: { harness: claude-code, provider: tensorx, model: z-ai/glm-5.3-flash"))).toThrow("router.yml low.reviewer: harness claude-code cannot use the openai api of provider tensorx");
});
test("the Team plan works only with claude-code, and never for the judge", () => {
  expect(() => loadRouter(edited("router.yml", "reviewer: { harness: pi, provider: tensorx, model: z-ai/glm-5.3-flash", "reviewer: { harness: pi, provider: team-plan, model: claude-sonnet-5-5"))).toThrow("router.yml low.reviewer: harness pi with provider team-plan: the Team plan works only with claude-code");
  expect(() => loadSeams(edited("seams.yml", "judgeModel: { provider: tensorx, model: deepseek/deepseek-v4.1-flash-1017 }", "judgeModel: { provider: team-plan, model: claude-sonnet-5-5 }"))).toThrow("seams.yml judgeModel: provider team-plan: the Team plan works only with claude-code");
  expect(() => loadSeams(edited("seams.yml", "judgeModel: { provider: tensorx, model: deepseek/deepseek-v4.1-flash-1017 }", "judgeModel: { provider: tensorx, model: nope }"))).toThrow("seams.yml judgeModel: provider tensorx has no model nope");
});
test("one row's author and reviewer may not share a model family", () => {
  const seams = loadSeams(edited("seams.yml", "z-ai/glm-5.3-flash: glm", "z-ai/glm-5.3-flash: deepseek"));
  expect(() => loadRouter(undefined, seams)).toThrow("router.yml low: author and reviewer are both family deepseek");
});
test("a seams.yml field of the wrong shape names the field", () => {
  expect(() => loadSeams(edited("seams.yml", "api: openai", "api: grpc"))).toThrow(/seams\.yml: providers\.tensorx\.api/);
});
test("an images entry must name a model of the provider", () => {
  expect(() => loadSeams(edited("seams.yml", "z-ai/glm-5.3-flash: glm } }", "z-ai/glm-5.3-flash: glm }, images: [nope] }"))).toThrow("seams.yml providers.tensorx.images: model nope is not in models");
});
test("react_frontend target has the 300-line limit and the protected paths", () => {
  const t = loadTarget("react_frontend", { defaultApprover: "approver" });
  expect(t.maxChangedLines).toBe(300);
  expect(t.protectedPaths).toEqual(expect.arrayContaining([".gitlab-ci.yml", ".factory.yml", "CLAUDE.md", "AGENTS.md", ".claude/**", ".agents/**", "**/Dockerfile*", "**/.gitattributes"]));
});
test(".factory.yml without build is rejected", () => {
  expect(() => parseFactoryFile("lint: pnpm lint\ntest: pnpm test")).toThrow(/build/);
});
test(".factory.yml without install is rejected", () => {
  expect(() => parseFactoryFile("lint: pnpm lint\ntest: pnpm test\nbuild: pnpm build")).toThrow(/install/);
  expect(parseFactoryFile("install: pnpm install --frozen-lockfile\nlint: a\ntest: b\nbuild: c").install).toBe("pnpm install --frozen-lockfile");
});
test("a target with a REPLACE_WITH_ placeholder is refused with a clear error", () => {
  expect(() => loadTarget("react_frontend", { defaultApprover: "REPLACE_WITH_GITLAB_USERNAME" })).toThrow(/targets\/react_frontend\.yml: defaultApprover is still a placeholder/);
  expect(loadTarget("react_frontend", { defaultApprover: "kirill" }).defaultApprover).toBe("kirill");
});

const BASE = "install: i\nlint: l\ntest: t\nbuild: b\n";
test("preview and previewUrl go together and previewUrl is a URL", () => {
  expect(() => parseFactoryFile(BASE + "preview: pnpm dev\n")).toThrow(/preview and previewUrl go together/);
  expect(() => parseFactoryFile(BASE + "previewUrl: http://localhost:3000\n")).toThrow(/preview and previewUrl go together/);
  expect(() => parseFactoryFile(BASE + "preview: pnpm dev\npreviewUrl: not-a-url\n")).toThrow();
  expect(parseFactoryFile(BASE + "preview: pnpm dev\npreviewUrl: http://localhost:3000\n")).toMatchObject({ preview: "pnpm dev", previewUrl: "http://localhost:3000" });
});
test("a target names its base branch; a missing or empty one is refused", () => {
  expect(loadTarget("react_frontend").baseBranch).toBe("develop");
  expect(() => loadTarget("react_frontend", { baseBranch: "" })).toThrow(/targets\/react_frontend\.yml: baseBranch/);
  expect(() => loadTarget("react_frontend", { baseBranch: undefined })).toThrow(/baseBranch Required/);
});
// Sets dashboardUrl itself, so these tests hold whatever the committed seams.yml says.
const withUrl = (url: string) => edited("seams.yml", /^dashboardUrl: .*$/m, `dashboardUrl: ${url}`);
test("a dashboardUrl that is still a placeholder is refused when the context is built, not when seams.yml loads", () => {
  for (const placeholder of ["REPLACE_WITH_DASHBOARD_URL", "REPLACE_WITH_URL"]) {
    const seams = loadSeams(withUrl(placeholder));
    expect(() => checkDashboardUrl(seams)).toThrow(/dashboardUrl is still a placeholder/);
  }
  expect(checkDashboardUrl(loadSeams(withUrl("https://factory.example.com")))).toBe("https://factory.example.com");
});
test("FACTORY_DASHBOARD_URL replaces dashboardUrl outside GitLab CI only, and gets the same checks", () => {
  const seams = loadSeams(withUrl("https://factory.example.com"));
  expect(checkDashboardUrl(seams, { FACTORY_DASHBOARD_URL: "https://localhost:3000" })).toBe("https://localhost:3000");
  expect(checkDashboardUrl(seams, { FACTORY_DASHBOARD_URL: "https://evil.example", GITLAB_CI: "true" })).toBe("https://factory.example.com");
  expect(() => checkDashboardUrl(seams, { FACTORY_DASHBOARD_URL: "http://localhost:3000" })).toThrow(/must be an https/);
});
test("a dashboardUrl that is not an https address is refused, so the token never goes in clear", () => {
  for (const bad of ["http://factory.example.com", "factory.example.com", "ftp://factory.example.com"]) {
    expect(() => checkDashboardUrl(loadSeams(withUrl(bad))), bad).toThrow(/dashboardUrl must be an https/);
  }
});
test("a target may set stuckMinutes, and a zero or negative value is refused", () => {
  expect(loadTarget("react_frontend", { defaultApprover: "kirill", stuckMinutes: { verify: 30 } }).stuckMinutes).toEqual({ verify: 30 });
  expect(() => loadTarget("react_frontend", { defaultApprover: "kirill", stuckMinutes: { verify: 0 } })).toThrow(/stuckMinutes/);
});
