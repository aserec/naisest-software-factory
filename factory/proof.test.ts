import { expect, test } from "vitest";
import { parseProof, proofPrompt, readImages, readProof, screenVerdicts } from "./proof";
import type { Finding } from "./agents";
import type { Proof } from "./proof";

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

// Review Focus 2: only a plain "matches" with both needed images loaded counts. Everything else is unsure.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const sc = (name: string, over: object = {}) => ({ name, reach: "r", width: 1280, isNew: false, ...over });
const F = (screen: string | undefined, verdict: string): Finding => ({ blocking: false, ...(screen ? { screen } : {}), verdict, text: `note ${screen}` });
test("a screen matches only with a plain matches verdict and the images it needs", () => {
  const proof: Proof = {
    visual: true,
    tests: [],
    screens: [
      sc("A", { before: "a-b.png", after: "a-a.png" }),
      sc("B", { before: "b-b.png" }),
      sc("C", { after: "c-a.png" }),
      sc("D", { isNew: true, after: "d-a.png" }),
      sc("E", { before: "e-b.png", after: "e-a.png" }),
    ],
  };
  const loaded = ["a-b.png", "a-a.png", "b-b.png", "c-a.png", "d-a.png", "e-b.png", "e-a.png"];
  const v = screenVerdicts([F("A", "matches"), F("B", "matches"), F("C", "matches"), F("D", "Matches"), F("Z", "does_not_match"), F(undefined, "unsure")], proof, loaded, true);
  const by = (n?: string) => v.find((x) => x.screen === n)!;
  expect(by("A").verdict).toBe("matches");
  expect(by("B")).toMatchObject({ verdict: "unsure", note: expect.stringMatching(/no after image/) });
  expect(by("C")).toMatchObject({ verdict: "unsure", note: expect.stringMatching(/no before image/) });
  expect(by("D")).toMatchObject({ verdict: "unsure", note: expect.stringMatching(/unknown verdict: Matches/) });
  expect(by("E")).toMatchObject({ verdict: "unsure", note: expect.stringMatching(/no verdict/) });
  expect(v.some((x) => x.screen === "Z")).toBe(false);
  expect(v.filter((x) => x.screen === undefined)).toHaveLength(1);
  expect(screenVerdicts([F("A", "yes")], { ...proof, screens: [proof.screens[0]] }, loaded, true)[0].verdict).toBe("unsure");
  for (const x of screenVerdicts([F("A", "matches")], proof, loaded, false)) expect(x).toMatchObject({ verdict: "unsure", note: expect.stringMatching(/cannot read images/) });
});
test("a does_not_match verdict is kept as it is", () => {
  const proof: Proof = { visual: true, tests: [], screens: [sc("A", { before: "a-b.png", after: "a-a.png" })] };
  expect(screenVerdicts([F("A", "does_not_match")], proof, ["a-b.png", "a-a.png"], true)[0].verdict).toBe("does_not_match");
});
// Review Focus 1: a file that is not a PNG never goes to the model.
test("readImages leaves out a file that is not a PNG", () => {
  const proof = parseProof(JSON.stringify(VALID)).proof;
  const bytes = (p: string) => (p.endsWith("after-list-1280.png") ? Buffer.from("-----BEGIN OPENSSH PRIVATE KEY-----") : PNG);
  expect(Object.keys(readImages(bytes, proof))).toEqual(["before-list-1280.png"]);
  expect(readImages(() => undefined, proof)).toEqual({});
  expect(readImages(bytes, undefined)).toEqual({});
});
test("proofPrompt lists the manifest and the images in order, or why there is no proof", () => {
  const proof = parseProof(JSON.stringify(VALID)).proof;
  expect(proofPrompt({ proof }, ["before-list-1280.png", "after-list-1280.png"])).toContain("Images, in the order attached: before-list-1280.png, after-list-1280.png");
  expect(proofPrompt({ proof }, [])).toContain("No images are attached.");
  expect(proofPrompt({ proof }, [])).toContain('"list page"');
  expect(proofPrompt({ error: "no run/proof/proof.json" }, [])).toBe("No valid proof: no run/proof/proof.json");
});
