import { expect, test } from "vitest";
import { loadTarget } from "./config";
import { checkHardRules, findSecrets, parseNumstat } from "./rules";

test("finds a GitLab token and a private key header", () => {
  expect(findSecrets("x glpat-abcdefghijklmnopqrst y")).toEqual(["glpat-abcdefghijklmnopqrst"]);
  expect(findSecrets("-----BEGIN RSA PRIVATE KEY-----")).toHaveLength(1);
  expect(findSecrets("-----BEGIN PRIVATE KEY-----")).toHaveLength(1);
});
test("plain text has no secrets", () => {
  expect(findSecrets("glpat-short and normal words")).toEqual([]);
});

const t = loadTarget("react_frontend");
test("a rename out of a protected path still fails", () => {
  const r = checkHardRules([{ oldPath: ".gitlab-ci.yml", newPath: "ci/old.yml", added: 0, removed: 0, binary: false }], "", t, true);
  expect(r.find(x => x.rule === "protected-path")!.passed).toBe(false);
});
test("binary files count as changed without breaking the line count", () => {
  const files = parseNumstat("-\t-\tapps/web/public/logo.png\0");
  expect(files[0]).toMatchObject({ binary: true, added: 0, removed: 0 });
  expect(checkHardRules(files, "", t, true).every(x => x.passed)).toBe(true);
});
test("301 changed lines fail the size rule, 300 pass", () => {
  const f = (n: number) => [{ oldPath: "a.ts", newPath: "a.ts", added: n, removed: 0, binary: false }];
  expect(checkHardRules(f(301), "", t, true).find(x => x.rule === "size")!.passed).toBe(false);
  expect(checkHardRules(f(300), "", t, true).find(x => x.rule === "size")!.passed).toBe(true);
});
test("a lock file change fails the dependency rule", () => {
  expect(checkHardRules([{ oldPath: "pnpm-lock.yaml", newPath: "pnpm-lock.yaml", added: 1, removed: 1, binary: false }], "", t, true).find(x => x.rule === "dependency-file")!.passed).toBe(false);
});
test("changing an existing test file passes", () => {
  expect(checkHardRules([{ oldPath: "src/a.test.ts", newPath: "src/a.test.ts", added: 3, removed: 2, binary: false }], "", t, true).every(x => x.passed)).toBe(true);
});
test("a red pipeline fails", () => expect(checkHardRules([], "", t, false).find(x => x.rule === "pipeline")!.passed).toBe(false));
test("a secret in the diff fails the secret rule", () => {
  expect(checkHardRules([], "+token glpat-abcdefghijklmnopqrst", t, true).find(x => x.rule === "secret")!.passed).toBe(false);
});
test("parses a file with spaces, a rename, and empty input", () => {
  expect(parseNumstat("1\t2\tsrc/my file.ts\0")).toEqual([{ oldPath: "src/my file.ts", newPath: "src/my file.ts", added: 1, removed: 2, binary: false }]);
  expect(parseNumstat("0\t0\t\0old.ts\0new.ts\0")).toEqual([{ oldPath: "old.ts", newPath: "new.ts", added: 0, removed: 0, binary: false }]);
  expect(parseNumstat("")).toEqual([]);
});
