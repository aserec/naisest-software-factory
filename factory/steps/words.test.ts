import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// Steps speak in factory words. A tool's own words, or an import of a tool module, mean a swap would change a step.
const TOOL_WORDS = /\bgitlab\b|\biid\b|\.labels?\b|mergeRequest|merge_request|PostToolUse|models\.json|playwright|chromium|from "\.\.\/(gitlab|teams|agents)"/i;
// The findings format and the ticket and request wrapping are the factory's, so these come from agents.
const AGENTS_OK = /^import \{ (?:(?:wrapTicket|wrapRequest|parseFindings|reviewerPrompt)(?:, )?)+ \} from "\.\.\/agents";$/;

const dir = fileURLToPath(new URL(".", import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "test-helpers.ts");

test.each(files)("%s uses no tool words", (file) => {
  const bad = readFileSync(`${dir}${file}`, "utf8").split("\n").filter((line) => TOOL_WORDS.test(line) && !AGENTS_OK.test(line));
  expect(bad).toEqual([]);
});
test("the check finds tool words", () => {
  expect(TOOL_WORDS.test('import { GitLab } from "../gitlab";')).toBe(true);
  expect(TOOL_WORDS.test("ctx.gitlab.getWorkItem(projectId, iid)")).toBe(true);
  expect(TOOL_WORDS.test("item.labels.includes(x)")).toBe(true);
  expect(TOOL_WORDS.test('import { runCommand } from "../agents";') && !AGENTS_OK.test('import { runCommand } from "../agents";')).toBe(true);
  expect(TOOL_WORDS.test("npx playwright screenshot")).toBe(true);
  expect(TOOL_WORDS.test("chromium")).toBe(true);
  expect(AGENTS_OK.test('import { parseFindings, reviewerPrompt } from "../agents";')).toBe(true);
});
