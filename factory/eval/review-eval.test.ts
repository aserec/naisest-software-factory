import { expect, test } from "vitest";
import { parseCase, reviewCase, score, type EvalCase } from "./review-eval";

const bug: EvalCase = { id: "b1", kind: "bug", set: "test", source: "https://x/pr/1", ticket: "Add a spinner", diff: "diff --git a/a.ts b/a.ts", review: "", proof: "", answer: "The list never hides the spinner after an error." };
const control: EvalCase = { ...bug, id: "c1", kind: "control", answer: "" };
const answer = (findings: object[]) => async () => JSON.stringify(findings);

test("a bug counts as found only when the judge names a finding, and as blocking only when that finding blocks", async () => {
  const findings = [{ blocking: false, text: "nit: rename x" }, { blocking: true, file: "a.ts", text: "spinner stays after an error" }];
  expect(await reviewCase(bug, answer(findings), async () => "2")).toMatchObject({ found: true, foundBlocking: true, flagged: true });
  expect(await reviewCase(bug, answer(findings), async () => "1")).toMatchObject({ found: true, foundBlocking: false });
  expect(await reviewCase(bug, answer(findings), async () => "0")).toMatchObject({ found: false, foundBlocking: false });
});

test("the judge sees the answer key and the numbered findings, and a reply out of range is an error, not a miss", async () => {
  let asked = "";
  const r = await reviewCase(bug, answer([{ blocking: true, text: "spinner stays" }]), async (p) => ((asked = p), "7"));
  expect(asked).toContain(bug.answer);
  expect(asked).toContain("1. [blocking] spinner stays");
  expect(r.error).toMatch(/7/);
});

test("the reviewer gets the case's ticket, diff, review.md and proof", async () => {
  let prompt = "";
  await reviewCase({ ...control, review: "REPO RULE", proof: "PROOF TEXT" }, async (p) => ((prompt = p), "[]"), async () => "0");
  for (const s of ["Add a spinner", "<diff>\ndiff --git a/a.ts b/a.ts\n</diff>", "REPO RULE", "<proof>\nPROOF TEXT\n</proof>"]) expect(prompt).toContain(s);
});
test("a control is flagged by any blocking finding, and no judge runs for it", async () => {
  const judge = async () => {
    throw new Error("no judge for a control");
  };
  expect(await reviewCase(control, answer([{ blocking: false, text: "[PRE-EXISTING] old bug" }]), judge)).toMatchObject({ flagged: false });
  expect(await reviewCase(control, answer([{ blocking: true, text: "bug" }]), judge)).toMatchObject({ flagged: true });
});

test("a reviewer that fails gives an error result, which the score counts apart", async () => {
  const r = await reviewCase(bug, async () => "no json here", async () => "0");
  expect(r.error).toMatch(/no JSON array/);
  const s = score([r, { ...r, error: undefined, found: true, foundBlocking: true }]);
  expect(s.test).toMatchObject({ bugs: 1, found: 1, foundBlocking: 1, errors: 1 });
});

test("the score splits tune from test, and counts flagged controls and the tags of findings", () => {
  const base = { error: undefined, found: false, foundBlocking: false, flagged: false, findings: [] };
  const s = score([
    { ...base, id: "a", kind: "bug", set: "test", found: true, findings: [{ blocking: false, text: "[PRE-EXISTING] x" }] },
    { ...base, id: "b", kind: "bug", set: "test" },
    { ...base, id: "c", kind: "control", set: "test", flagged: true, findings: [{ blocking: true, text: "[SECURITY] y" }] },
    { ...base, id: "d", kind: "control", set: "tune" },
  ]);
  expect(s.test).toEqual({ bugs: 2, found: 1, foundBlocking: 0, controls: 1, flagged: 1, errors: 0, preExisting: 1, security: 1 });
  expect(s.tune).toEqual({ bugs: 0, found: 0, foundBlocking: 0, controls: 1, flagged: 0, errors: 0, preExisting: 0, security: 0 });
});

test("a bug case without an answer key is refused", () => {
  expect(() => parseCase({ ...bug, answer: " " }, "b1.json")).toThrow(/answer/);
  expect(parseCase(control, "c1.json").kind).toBe("control");
});
