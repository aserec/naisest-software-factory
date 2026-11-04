import { expect, test } from "vitest";
import { addStep, newRecord, runFacts, type RequestRound } from "./record";
import { cursorLine, isRequest, later, readCursor, stateReply } from "./requests";
import { injectionQuestion } from "./triage";

test("a request is a comment with @factory that is not a stop or resume", () => {
  expect(isRequest("@factory the 409 shows a blank page")).toBe(true);
  expect(isRequest("Looks off.\n\n@Factory add a screenshot")).toBe(true);
  for (const b of ["@factory stop", " @factory resume \n", "@factory stop\nalso fix the button", "ping @factory-bot", "mail a@factory.dev", "the factory did this"]) expect(isRequest(b)).toBe(false);
});
test("the cursor is read only from the factory's own comments", () => {
  const c = (byFactory: boolean, body: string, at: string) => ({ author: "x", byFactory, body, at });
  expect(readCursor([c(false, cursorLine("2026-11-04T12:00:00Z"), "3"), c(true, `Done.\n\n${cursorLine("2026-11-04T10:00:00Z")}`, "2"), c(true, cursorLine("2026-11-04T09:00:00Z"), "1")])).toBe("2026-11-04T10:00:00Z");
  expect(readCursor([c(true, "no line", "1")])).toBeUndefined();
});
test("the cursor comes from the newest factory comment by time, wherever it is listed", () => {
  const c = (body: string, at: string) => ({ author: "x", byFactory: true, body, at });
  // 12:00:00.500Z is later than 13:59:59+02:00 (11:59:59Z) although it sorts earlier as text.
  expect(readCursor([c(cursorLine("old"), "2026-11-04T13:59:59+02:00"), c(cursorLine("new"), "2026-11-04T12:00:00.500Z")])).toBe("new");
  // The newest factory comment without a line does not hide an older one with a line.
  expect(readCursor([c(cursorLine("old"), "2026-11-04T10:00:00Z"), c("no line", "2026-11-04T11:00:00Z")])).toBe("old");
});
test("later compares times, not text", () => {
  expect(later("2026-11-04T10:00:00Z", "2026-11-04T10:00:00.500Z")).toBe("2026-11-04T10:00:00.500Z");
  expect(later(undefined, "2026-11-04T10:00:00Z")).toBe("2026-11-04T10:00:00Z");
  expect(later("2026-11-04T10:00:00Z", undefined)).toBe("2026-11-04T10:00:00Z");
  expect(later(undefined, undefined)).toBeUndefined();
});
test("the state reply names the author and says what the state allows", () => {
  const r = stateReply("ana", "stopped");
  expect(r.startsWith("@ana The factory takes @factory requests only while its change waits for a person (factory_needs_approval).")).toBe(true);
  expect(r).toContain("@factory resume");
  expect(stateReply("ana", "done")).toContain("This work is done.");
  expect(stateReply("ana", undefined)).toContain("The factory has not started work here.");
});
test("runFacts reports an open round and a round start", () => {
  const round: RequestRound = { cursor: "t", requests: [], costAtStart: 0, tokensAtStart: { input: 0, output: 0 } };
  let r = addStep(newRecord(), "event", { start: true });
  expect(runFacts(r)).toMatchObject({ roundStart: false, openRound: undefined, requested: false });
  r = { ...addStep(r, "event", { round: 1 }), requestRounds: [{ ...round, endedAt: "x" }, round] };
  expect(runFacts(r)).toMatchObject({ roundStart: true, openRound: round, requested: true });
  r = { ...addStep(r, "questions", {}), requestRounds: [{ ...round, endedAt: "x" }] };
  expect(runFacts(r)).toMatchObject({ roundStart: false, openRound: undefined, requested: true });
});
test("the injection question is the triage one", () => expect(injectionQuestion.id).toBe("injection"));
