import { expect, test } from "vitest";
import { askDuplicateCheck, decideDuplicate } from "./duplicate-check";
import { fakeJudge } from "./fakes";
import type { JevQuestion } from "./seams";

test("decideDuplicate closes only on a sure same", () => {
  const a = (verdict: string, confidence: number) => ({ verdict, confidence, closest: "9", injectionYes: 0 });
  expect(decideDuplicate(a("same", 0.9))).toBe("same");
  expect(decideDuplicate(a("same", 0.89))).toBe("overlaps");
  expect(decideDuplicate(a("same", NaN))).toBe("overlaps");
  expect(decideDuplicate(a("overlaps", 0.99))).toBe("overlaps");
  expect(decideDuplicate(a("different", 0.5))).toBe("different");
  expect(decideDuplicate(a("other", 0.99))).toBe("overlaps");
});

test("askDuplicateCheck sends the newest 200 others, cut to 300 characters, and no judge call with none", async () => {
  const open = Array.from({ length: 205 }, (_, i) => ({ ref: String(300 - i), title: `t${i}`, body: "x".repeat(400), open: true, marks: [], tags: [], assignees: [], url: "" }));
  open.splice(3, 0, { ...open[0], ref: "8" }); // the ticket itself
  let state: any; let questions: JevQuestion[] = [];
  const judge = fakeJudge((q, s) => { state = s; return { id: q.id, value: q.kind === "choice" ? q.options[0] : 0.1, probability: 0.1, confidence: 0.9 }; });
  judge.ask = ((ask) => async (s: unknown, qs: JevQuestion[]) => { questions = qs; return ask(s, qs); })(judge.ask);
  await askDuplicateCheck(judge, { ref: "8", title: "T", description: "D" }, open);
  expect(state.candidates).toHaveLength(200);
  expect(state.candidates[0].ref).toBe("300");
  expect(state.candidates.at(-1).ref).toBe("101"); // refs 300 down to 96 are 205, so the newest 200 end at 101
  expect(state.candidates.map((c: any) => c.ref)).not.toContain("8");
  expect(state.candidates[0].body).toHaveLength(300);
  expect(questions.find((q) => q.id === "dedupe")).toMatchObject({ options: ["different", "overlaps", "same"] });
  const none = fakeJudge(() => { throw new Error("no call"); });
  expect(await askDuplicateCheck(none, { ref: "8", title: "T", description: "D" }, [{ ...open[0], ref: "8" }])).toBeUndefined();
});

// A real backlog: sibling tickets of one epic, their blockers and the epic itself all got the question.
test("askDuplicateCheck leaves out epics and the work items the ticket names", async () => {
  const t = (ref: string, epic = false) => ({ ref, title: `t${ref}`, body: "b", open: true, marks: [], tags: [], assignees: [], url: "", epic });
  let state: any;
  const judge = fakeJudge((q, s) => { state = s; return { id: q.id, value: q.kind === "choice" ? q.options[0] : 0.1, probability: 0.1, confidence: 0.9 }; });
  const ticket = { ref: "110", title: "Publish a Draft", description: "Blocked by #109. Epic: #103. Not #10." };
  await askDuplicateCheck(judge, ticket, [t("111"), t("109"), t("108"), t("103", true), t("100", true), t("1091"), t("10")]);
  expect(state.candidates.map((c: any) => c.ref)).toEqual(["111", "108", "1091"]);
  const none = fakeJudge(() => { throw new Error("no call"); });
  expect(await askDuplicateCheck(none, ticket, [t("109"), t("100", true)])).toBeUndefined();
});
