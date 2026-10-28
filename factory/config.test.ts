import { expect, test } from "vitest";
import { loadRouter, loadTarget, parseFactoryFile } from "./config";

test("router.yml gives the spec's models and bump", () => {
  const r = loadRouter();
  expect(r.low).toMatchObject({ author: "claude-sonnet-5-5", effort: "medium", mayAutoMerge: true });
  expect(r.high).toMatchObject({ author: "claude-opus-5-5", effort: "high", mayAutoMerge: false });
  expect(r.effortBump).toBe(8);
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
