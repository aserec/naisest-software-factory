import { expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProof, proofPrompt, proofReasons, proofSection, readImages, readProof, screenVerdicts, writeShooter } from "./proof";
import type { Finding } from "./agents";
import type { Proof, ProofRecord } from "./proof";
import { TEST_PROOF, VISUAL_PROOF as VISUAL } from "./steps/test-helpers";

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
test("two screens cannot share a name", () => {
  const two = (b: object) => JSON.stringify({ ...VALID, screens: [VALID.screens[0], { ...VALID.screens[0], before: "before-list-375.png", after: "after-list-375.png", width: 375, ...b }] });
  expect(parseProof(two({ name: "list page" })).error).toMatch(/unique/);
  expect(parseProof(two({ name: "list  page" })).error).toBeDefined(); // compared after the one-line cleanup
  expect(parseProof(two({ name: "list page 375" })).error).toBeUndefined();
});
test("an image file is used once: not twice on a screen and not on two screens", () => {
  expect(parseProof(screen({ before: "after-list-1280.png" })).error).toMatch(/once/);
  const other = { ...VALID.screens[0], name: "other", after: "after-other.png" };
  expect(parseProof(JSON.stringify({ ...VALID, screens: [VALID.screens[0], other] })).error).toMatch(/once/);
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
test("a does_not_match verdict with no screen is a whole-proof unsure item", () => {
  const proof: Proof = { visual: true, tests: [], screens: [] };
  expect(screenVerdicts([F(undefined, "does_not_match")], proof, [], true)).toEqual([{ verdict: "unsure", note: "note undefined" }]);
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

// The reasons a change without proof goes to a person.
const rec = (proof: Proof | undefined, over: Partial<ProofRecord> = {}): ProofRecord => ({ proof, verdicts: [], readsImages: true, reviewer: "pi/model-x", ...over });
const VISUAL_PROOF: Proof = { ...VISUAL, screens: VISUAL.screens.map((s) => ({ ...s, isNew: false })) };
const matches = [{ screen: "list page", verdict: "matches" as const, note: "ok" }];
const passingTest = (before: number) => ({ ...TEST_PROOF.tests[0], before: { exit: before, tail: "" } });
test("proofReasons: no record, or no valid proof, gives only the no proof reason", () => {
  expect(proofReasons(undefined, true)).toEqual(["no proof: code review saved no proof"]);
  expect(proofReasons(rec(undefined, { error: "no run/proof/proof.json" }), true)).toEqual(["no proof: no run/proof/proof.json"]);
});
test("proofReasons: a visual change with a preview and no screens", () => {
  expect(proofReasons(rec({ visual: true, screens: [], tests: [], note: "the dev server did not start" }), true)).toEqual(["a visual change was expected but there are no screenshots: the dev server did not start"]);
  expect(proofReasons(rec({ visual: true, screens: [], tests: [] }), true)).toEqual(["a visual change was expected but there are no screenshots: no reason given", "the proof has no tests and its note gives no reason"]);
});
test("proofReasons: a reviewer that cannot read images judged no screen", () => {
  expect(proofReasons(rec(VISUAL_PROOF, { readsImages: false, verdicts: [{ screen: "list page", verdict: "unsure", note: "the reviewer cannot read images" }, { verdict: "unsure", note: "odd" }] }), true)).toEqual(["the reviewer pi/model-x cannot read images, so no screen was judged", "the reviewer is unsure: odd"]);
});
test("proofReasons: each unsure verdict, with or without a screen", () => {
  const verdicts = [{ screen: "list page", verdict: "unsure" as const, note: "cannot see the spinner" }, { verdict: "unsure" as const, note: "odd" }];
  expect(proofReasons(rec(VISUAL_PROOF, { verdicts }), true)).toEqual(["screen list page: the reviewer is unsure: cannot see the spinner", "the reviewer is unsure: odd"]);
});
test("proofReasons: a saved does_not_match is a reason, and a note is cut to one line of 200 chars", () => {
  const verdicts = [{ screen: "list page", verdict: "does_not_match" as const, note: "no spinner\n| <b>x</b> " + "y".repeat(300) }];
  const [reason] = proofReasons(rec(VISUAL_PROOF, { verdicts }), true);
  expect(reason).toMatch(/^screen list page: the reviewer says it does not match: no spinner/);
  expect(reason).not.toContain("\n");
  expect(reason.length).toBeLessThan("screen list page: the reviewer says it does not match: ".length + 201);
});
test("proofReasons: a change with no visual part needs a test that failed before and passed after", () => {
  expect(proofReasons(rec(TEST_PROOF), false)).toEqual([]);
  expect(proofReasons(rec({ ...TEST_PROOF, tests: [passingTest(0)] }), false)).toEqual(["no test failed before the change and passed after it"]);
  expect(proofReasons(rec({ ...TEST_PROOF, tests: [] }), true)).toEqual(["no test failed before the change and passed after it"]);
});
test("proofReasons: a test-only diff needs its tests to pass after, not to fail before", () => {
  expect(proofReasons(rec({ ...TEST_PROOF, tests: [passingTest(0)] }), false, [], true)).toEqual([]);
  expect(proofReasons(rec({ ...TEST_PROOF, tests: [passingTest(0), { ...passingTest(0), after: { exit: 1, tail: "1 failed" } }] }), false, [], true)).toEqual(["the change touches only tests, but no test passed after it"]);
  expect(proofReasons(rec({ ...TEST_PROOF, tests: [] }), false, [], true)).toEqual(["the change touches only tests, but no test passed after it"]);
});
test("proofReasons: a proof with no tests needs a reason in its note", () => {
  expect(proofReasons(rec({ ...VISUAL_PROOF, tests: [], note: undefined }, { verdicts: matches }), true)).toEqual(["the proof has no tests and its note gives no reason"]);
  expect(proofReasons(rec({ ...VISUAL_PROOF, tests: [], note: "only a color changes; no test can see it" }, { verdicts: matches }), true)).toEqual([]);
});
test("proofReasons: a visual change with a preview and matching screens needs no test that failed before", () => {
  expect(proofReasons(rec(VISUAL_PROOF, { verdicts: matches }), true)).toEqual([]);
  expect(proofReasons(rec({ ...VISUAL_PROOF, tests: [passingTest(0)] }, { verdicts: matches }), true)).toEqual([]);
  expect(proofReasons(rec({ ...VISUAL_PROOF, tests: [passingTest(0)] }, { verdicts: matches }), false)).toEqual(["no test failed before the change and passed after it"]);
});

// The Proof section of the change.
const links = { "before-list-1280.png": "/uploads/1/before-list-1280.png", "after-list-1280.png": "/uploads/2/after-list-1280.png", "after-settings-1280.png": "/uploads/3/after-settings-1280.png" };
test("proofSection: two screens and a test render as the B2 mockup", () => {
  const settings = { name: "settings page", reach: "http://localhost:3000/settings", width: 1280, isNew: true, after: "after-settings-1280.png" };
  const r = rec({ ...VISUAL_PROOF, screens: [...VISUAL_PROOF.screens, settings] }, { verdicts: [{ screen: "list page", verdict: "matches", note: "the list now shows the spinner." }, { screen: "settings page", verdict: "unsure", note: "..." }] });
  expect(proofSection(r, links)).toBe(`## Proof

### Screen 1: list page, 1280 px: matches
| Before | After |
| --- | --- |
| ![before](/uploads/1/before-list-1280.png) | ![after](/uploads/2/after-list-1280.png) |

Reviewer: the list now shows the spinner.

### Screen 2: settings page, 1280 px, new screen: unsure
| After |
| --- |
| ![after](/uploads/3/after-settings-1280.png) |

Reviewer: ...

### Tests
- list-spinner: failed before, passes after`);
});
test("proofSection: agent and reviewer text cannot start a quick action, break the table or run past 200 chars", () => {
  const name = "a\n/merge |x| <img src=x>";
  const r = rec({ ...VISUAL_PROOF, screens: [{ ...VISUAL_PROOF.screens[0], name }], tests: [{ ...TEST_PROOF.tests[0], name: "t\n/close" }], note: "n\n/merge" }, { verdicts: [{ screen: name, verdict: "matches", note: "ok\n/merge" }, { screen: name, verdict: "matches", note: "x".repeat(300) }] });
  const s = proofSection(r, links);
  expect(s).not.toMatch(/^\s*\//m);
  expect(s).toContain("\\|x\\|");
  expect(s).toContain("&lt;img src=x&gt;");
  expect(s).not.toContain("<img");
  const long = proofSection(rec(VISUAL_PROOF, { verdicts: [{ screen: "list page", verdict: "matches", note: "x".repeat(300) }] }), links);
  expect(long).toContain(`Reviewer: ${"x".repeat(200)}\n`);
  expect(proofSection(rec(undefined, { error: `bad ${"y".repeat(300)}` }), {})).toBe(`## Proof\n\nNo proof: bad ${"y".repeat(196)}`);
});
test("proofSection: no proof, no screens and no tests", () => {
  expect(proofSection(rec(undefined, { error: "no run/proof/proof.json" }), {})).toBe("## Proof\n\nNo proof: no run/proof/proof.json");
  expect(proofSection(undefined, {})).toBe("## Proof\n\nNo proof: code review saved no proof");
  expect(proofSection(rec({ visual: false, screens: [], tests: [], note: "a text change" }), {})).toBe("## Proof\n\nNo screenshots: a text change\n\n### Tests\nNo test proof.");
  expect(proofSection(rec({ visual: false, screens: [], tests: [passingTest(0)] }), {})).toContain("- list-spinner: passed before, passes after");
  expect(proofSection(rec({ visual: false, screens: [], tests: [{ ...TEST_PROOF.tests[0], after: { exit: 1, tail: "" } }] }), {})).toContain("- list-spinner: failed before, fails after");
});
test("proofSection: an image without a link says why", () => {
  const s = proofSection(rec(VISUAL_PROOF, { verdicts: matches }), { "after-list-1280.png": links["after-list-1280.png"] }, ["before-list-1280.png"]);
  expect(s).toContain("| image upload failed | ![after](/uploads/2/after-list-1280.png) |");
  expect(proofSection(rec(VISUAL_PROOF, { verdicts: matches }), {})).toContain("| no image | no image |");
});
test("proofReasons: an upload that failed sends the change to a person, last", () => {
  expect(proofReasons(rec(VISUAL_PROOF, { verdicts: matches }), true, ["before-list-1280.png"])).toEqual(["image upload failed: before-list-1280.png"]);
  expect(proofReasons(rec(VISUAL_PROOF, { verdicts: matches }), true, ["a.png", "b.png"])).toEqual(["image upload failed: a.png, b.png"]);
  expect(proofReasons(rec({ ...TEST_PROOF, tests: [] }), false, ["a.png"])).toEqual(["no test failed before the change and passed after it", "image upload failed: a.png"]);
});

// The real script against a stub playwright that records its arguments, and a file:// page curl can reach.
function shoot(c: { login?: string }, user: string[], before?: (dir: string) => void) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "shoot-")));
  writeShooter(dir, { preview: "sleep 30", ...c });
  mkdirSync(join(dir, "run/proof"), { recursive: true });
  mkdirSync(join(dir, "node_modules/.bin"), { recursive: true });
  writeFileSync(join(dir, "node_modules/.bin/playwright"), `#!/bin/sh\necho "$@" > "${dir}/args"\n`, { mode: 0o755 });
  before?.(dir);
  const r = spawnSync("bash", ["run/shoot.sh", `file://${dir}/args-page`, "page", "1280", ".", ...user], { cwd: dir, encoding: "utf8" });
  const args = existsSync(join(dir, "args")) ? readFileSync(join(dir, "args"), "utf8") : "";
  return { code: r.status, out: r.stdout, args, dir };
}
const page = (dir: string) => writeFileSync(join(dir, "args-page"), "");

test("shoot.sh logs the user in with the target's login command and shoots with that session", () => {
  const r = shoot({ login: `printf '{"user":"%s"}' "$FACTORY_USER" > "$FACTORY_STORAGE"` }, ["teacher"], page);
  expect(r.code).toBe(0);
  expect(r.args).toContain(`--load-storage ${r.dir}/run/auth-teacher.json`);
  expect(readFileSync(join(r.dir, "run/auth-teacher.json"), "utf8")).toBe('{"user":"teacher"}');
});

test("shoot.sh without a login command uses the session file the agent wrote", () => {
  const r = shoot({}, ["teacher"], (d) => { page(d); writeFileSync(join(d, "run/auth-teacher.json"), "{}"); });
  expect(r.code).toBe(0);
  expect(r.args).toContain("--load-storage");
});

test("shoot.sh takes no anonymous shot when the user has no session", () => {
  const r = shoot({}, ["teacher"], page);
  expect(r.code).toBe(1);
  expect(r.out).toContain("run/auth-teacher.json");
  expect(r.args).toBe("");
});

test("shoot.sh with no user shoots without a session", () => {
  const r = shoot({ login: "exit 1" }, [], page);
  expect(r.code).toBe(0);
  expect(r.args).not.toContain("--load-storage");
});
