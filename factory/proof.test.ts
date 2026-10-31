import { expect, test } from "vitest";
import { parseProof, readProof } from "./proof";

const VALID = {
  visual: true,
  screens: [{ name: "list page", reach: "http://localhost:3000/list", width: 1280, before: "before-list-1280.png", after: "after-list-1280.png" }],
  tests: [{ name: "list-spinner", command: "pnpm test", before: { exit: 1, tail: "1 failed" }, after: { exit: 0, tail: "1 passed" } }],
};
const screen = (over: object) => JSON.stringify({ ...VALID, screens: [{ ...VALID.screens[0], ...over }] });

test("a valid manifest parses and isNew defaults to false", () => {
  expect(parseProof(JSON.stringify(VALID)).proof).toEqual({ ...VALID, screens: [{ ...VALID.screens[0], isNew: false }] });
});
test("missing, huge, bad and oversized input gives an error and does not throw", () => {
  expect(parseProof(undefined).error).toMatch(/no run\/proof\/proof.json/);
  expect(parseProof("x".repeat(200_001)).error).toBeDefined();
  expect(parseProof("{not json").error).toBeDefined();
  const s = VALID.screens[0];
  expect(parseProof(JSON.stringify({ ...VALID, screens: Array(6).fill(s) })).error).toBeDefined();
  expect(parseProof(JSON.stringify({ ...VALID, tests: Array(21).fill(VALID.tests[0]) })).error).toBeDefined();
});
test("a tail keeps its last 1000 chars and a name becomes one line", () => {
  const t = { ...VALID.tests[0], before: { exit: 1, tail: "a".repeat(50_000) + "END" } };
  const tail = parseProof(JSON.stringify({ ...VALID, tests: [t] })).proof?.tests[0].before.tail;
  expect(tail).toHaveLength(1000);
  expect(tail?.endsWith("END")).toBe(true);
  expect(parseProof(screen({ name: "list\npage" })).proof?.screens[0].name).toBe("list page");
});
test("an image name must be a plain lowercase png directly in run/proof/", () => {
  for (const after of ["../../.git/config", "sub/after.png", "After.PNG"]) expect(parseProof(screen({ after })).error).toBeDefined();
});
test("readProof reports a link and returns the raw text", () => {
  expect(readProof(() => { throw new Error("Refused"); }).error).toMatch(/link/);
  expect(readProof(() => JSON.stringify(VALID)).raw).toBe(JSON.stringify(VALID));
});
