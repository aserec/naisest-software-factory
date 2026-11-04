import { expect, test } from "vitest";
import { loadTarget } from "./config";
import { addKnownSecrets, checkHardRules, findSecrets, maskSecrets, parseNumstat } from "./rules";

test("finds a GitLab token and a private key header", () => {
  expect(findSecrets("x glpat-abcdefghijklmnopqrst y")).toEqual(["glpat-abcdefghijklmnopqrst"]);
  expect(findSecrets("-----BEGIN RSA PRIVATE KEY-----")).toHaveLength(1);
  expect(findSecrets("-----BEGIN PRIVATE KEY-----")).toHaveLength(1);
});
test("plain text has no secrets", () => {
  expect(findSecrets("glpat-short and normal words")).toEqual([]);
});

const t = loadTarget("react_frontend", { defaultApprover: "approver" });
test("a rename out of a protected path still fails", () => {
  const r = checkHardRules([{ oldPath: ".gitlab-ci.yml", newPath: "ci/old.yml", added: 0, removed: 0, binary: false }], "", t, true);
  expect(r.find(x => x.rule === "protected-path")!.passed).toBe(false);
});
test("binary files count as changed without breaking the line count", () => {
  const files = parseNumstat("-\t-\tapps/web/public/logo.png\0");
  expect(files[0]).toMatchObject({ binary: true, added: 0, removed: 0 });
  expect(checkHardRules(files, "", t, true).every(x => x.passed)).toBe(true);
});
test("with maxChangedLines 300, 301 changed lines fail the size rule and 300 pass", () => {
  const f = (n: number) => [{ oldPath: "a.ts", newPath: "a.ts", added: n, removed: 0, binary: false }];
  const limited = { ...t, maxChangedLines: 300 };
  expect(checkHardRules(f(301), "", limited, true).find(x => x.rule === "size")!.passed).toBe(false);
  expect(checkHardRules(f(300), "", limited, true).find(x => x.rule === "size")!.passed).toBe(true);
});
test("a target without maxChangedLines passes any size and still reports the line count", () => {
  const f = [{ oldPath: "a.ts", newPath: "a.ts", added: 1500, removed: 38, binary: false }];
  expect(checkHardRules(f, "", t, true).find(x => x.rule === "size")).toEqual({ rule: "size", passed: true, detail: "1538 lines changed, no limit" });
});
test("a lock file change fails the dependency rule", () => {
  expect(checkHardRules([{ oldPath: "pnpm-lock.yaml", newPath: "pnpm-lock.yaml", added: 1, removed: 1, binary: false }], "", t, true).find(x => x.rule === "dependency-file")!.passed).toBe(false);
});
test("changing an existing test file passes", () => {
  expect(checkHardRules([{ oldPath: "src/a.test.ts", newPath: "src/a.test.ts", added: 3, removed: 2, binary: false }], "", t, true).every(x => x.passed)).toBe(true);
});
test("a red pipeline fails", () => expect(checkHardRules([], "", t, false).find(x => x.rule === "pipeline")!.passed).toBe(false));
test("a secret in the diff fails the secret rule and is not printed", () => {
  const r = checkHardRules([], "+token glpat-abcdefghijklmnopqrst", t, true).find(x => x.rule === "secret")!;
  expect(r.passed).toBe(false);
  expect(r.detail).not.toContain("glpat-");
});
const one = (oldPath: string, newPath: string, added = 1, removed = 1) => [{ oldPath, newPath, added, removed, binary: false }];
test("a rename into a protected path fails", () => {
  expect(checkHardRules(one("src/x.yml", ".gitlab-ci.yml"), "", t, true).find(x => x.rule === "protected-path")!.passed).toBe(false);
});
test("deleting a protected file fails", () => {
  expect(checkHardRules(parseNumstat("0\t5\t.gitlab-ci.yml\0"), "", t, true).find(x => x.rule === "protected-path")!.passed).toBe(false);
});
test("parses a file with spaces in its name", () => {
  expect(parseNumstat("1\t2\tsrc/my file.ts\0")).toEqual(one("src/my file.ts", "src/my file.ts", 1, 2));
});
test("parses a rename", () => {
  expect(parseNumstat("0\t0\t\0old.ts\0new.ts\0")).toEqual(one("old.ts", "new.ts", 0, 0));
});
test("empty numstat gives an empty list", () => expect(parseNumstat("")).toEqual([]));
test.each([
  ["empty counts", "\t\ta.ts\0"],
  ["negative count", "-500\t0\ta.ts\0"],
  ["non-number count", "abc\t1\ta.ts\0"],
  ["one dash only", "-\t1\ta.ts\0"],
  ["missing tabs", "1 2 a.ts\0"],
  ["truncated rename", "0\t0\t\0old.ts\0"],
  ["rename with no paths", "0\t0\t\0"],
])("malformed numstat throws: %s", (_name, input) => {
  expect(() => parseNumstat(input)).toThrow();
});
test("Anthropic keys and GitLab CI job tokens are secrets", () => {
  expect(findSecrets("x sk-ant-oat01-abc y")).toHaveLength(1);
  expect(findSecrets("x glcbt-64_abc y")).toHaveLength(1);
});
test("a secret value this process holds is found, and never shown", () => {
  addKnownSecrets("https://teams.example/webhook/abc123", "short", undefined);
  const found = findSecrets("post to https://teams.example/webhook/abc123 now");
  expect(found).toHaveLength(1);
  expect(found.join()).not.toContain("abc123");
  expect(findSecrets("a short note")).toEqual([]);
});
test("maskSecrets hides secret patterns and the secret values this process holds", () => {
  expect(maskSecrets("x glpat-abcdefghijklmnopqrstuv y")).toBe("x [secret] y");
  addKnownSecrets("known-value-0123456789abc");
  expect(maskSecrets("a known-value-0123456789abc b known-value-0123456789abc")).toBe("a [secret] b [secret]");
  expect(maskSecrets("plain words")).toBe("plain words");
});
