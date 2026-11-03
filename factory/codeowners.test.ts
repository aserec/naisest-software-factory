import { expect, test } from "vitest";
import { ownersOf, parseCodeowners, topOwners } from "./codeowners";

test("comments, blank lines and section headers are skipped", () => {
  const rules = parseCodeowners("# a comment\n\n[Docs]\n^[Optional] @x\n[Docs][2] @x\n*.md @ana\n");
  expect(rules).toEqual([{ pattern: "*.md", owners: ["ana"] }]);
});
test("the last matching rule wins", () => {
  const rules = parseCodeowners("*.ts @ana\n/src/auth/ @ben\n");
  expect(ownersOf(rules, "src/auth/login.ts")).toEqual(["ben"]);
  expect(ownersOf(rules, "src/other.ts")).toEqual(["ana"]);
  expect(ownersOf(rules, "README.md")).toEqual([]);
});
test("a directory pattern matches below it, a leading slash anchors, a bare name matches at any depth", () => {
  const rules = parseCodeowners("docs/ @d\n/build @b\nMakefile @m\n");
  expect(ownersOf(rules, "docs/a/b.md")).toEqual(["d"]);
  expect(ownersOf(rules, "build/out.js")).toEqual(["b"]);
  expect(ownersOf(rules, "src/build")).toEqual([]);
  expect(ownersOf(rules, "Makefile")).toEqual(["m"]);
  expect(ownersOf(rules, "a/b/Makefile")).toEqual(["m"]);
});
test("teams and emails are dropped, and a rule left with no owners still wins", () => {
  const rules = parseCodeowners("src/ @ana\nsrc/ @org/team ana@example.com\n");
  expect(rules[1].owners).toEqual([]);
  expect(ownersOf(rules, "src/a.ts")).toEqual([]);
});
test("topOwners ranks by owned paths, ties in file order", () => {
  const rules = parseCodeowners("a.ts @ana\nb.ts @ben\nc.ts @ana\n");
  expect(topOwners(rules, ["a.ts", "b.ts", "c.ts"])).toEqual(["ana", "ben"]);
  expect(topOwners(rules, ["b.ts", "a.ts"])).toEqual(["ana", "ben"]);
  expect(topOwners(rules, ["x.ts"])).toEqual([]);
});
test("a glob pattern matches only at its own level, a plain name also matches below it", () => {
  const rules = parseCodeowners("docs/* @a\n*.ts @t\ndocs2/** @g\nlib/** @l\nbin @p\n");
  expect(ownersOf(rules, "docs/a.md")).toEqual(["a"]);
  expect(ownersOf(rules, "docs/a/b.md")).toEqual([]);
  expect(ownersOf(rules, "docs2/a/b.md")).toEqual(["g"]);
  expect(ownersOf(rules, "lib/a.md")).toEqual(["l"]);
  expect(ownersOf(rules, "lib/a/b.md")).toEqual(["l"]);
  expect(ownersOf(rules, "bin/a/b.sh")).toEqual(["p"]);
  expect(ownersOf(rules, "x/a.ts")).toEqual(["t"]);
  expect(ownersOf(rules, "a.ts/b.md")).toEqual([]);
});
