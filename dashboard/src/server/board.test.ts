import { expect, test } from "vitest";
import { boardWithRuns } from "./board";
import { openDb } from "./db";
import type { RunEvent } from "software-factory/run-events";

const row = { target: "t", title: "x", url: "", updatedAt: "" };

test("a card's state time is the factory's last change, and none when a person moved the card since", () => {
  const db = openDb(":memory:");
  const change = (ticket: string, to: string, at: string) => ({ id: `${ticket}-${at}`, run: `r${ticket}`, at, target: "t", ticket, type: "label_change" as const, data: { to } });
  db.addEvents([change("1", "running", "2026-01-01T10:00:00Z"), change("1", "done", "2026-01-01T12:00:00Z"), change("2", "running", "2026-01-01T10:00:00Z")]);
  const items = boardWithRuns([{ ...row, ticket: "1", state: "done" }, { ...row, ticket: "2", state: "ready" }], db, [], new Date());
  expect(items.map((i) => i.stateSince)).toEqual(["2026-01-01T12:00:00Z", undefined]);
});

test("the tracker's live conflicts win over the run's events, which fill in when the tracker cannot tell", () => {
  const db = openDb(":memory:");
  const env = (ticket: string, id: string) => ({ id: `${ticket}-${id}`, run: `r${ticket}`, at: "2026-01-01T10:00:00Z", target: "t", ticket });
  db.addEvents(["1", "2"].flatMap((t) => [{ ...env(t, "a"), type: "run_start" as const, data: {} }, { ...env(t, "b"), type: "change_state" as const, data: { conflicts: true } }]));
  const items = boardWithRuns([{ ...row, ticket: "1", state: "needs_approval", conflicts: false }, { ...row, ticket: "2", state: "needs_approval" }, { ...row, ticket: "3", state: "needs_approval", conflicts: true }], db, [], new Date());
  expect(items.map((i) => i.conflicts)).toEqual([false, true, true]);
});

test("a card counts the conflict rounds that reached a decision, across runs, and when the newest did", () => {
  const db = openDb(":memory:");
  const ev = (ticket: string, run: string, at: string, type: "change_state" | "decision", n: number) => ({ id: `${run}-${n}`, run, at, target: "t", ticket, type, data: type === "decision" ? { auto: false, reasons: [] } : { conflicts: true } }) as RunEvent;
  db.addEvents([
    ev("1", "a", "2026-01-01T10:00:00Z", "decision", 1), // a decision with no conflict round before it
    ev("1", "b", "2026-01-02T10:00:00Z", "change_state", 1), ev("1", "b", "2026-01-02T11:00:00Z", "decision", 2),
    ev("1", "c", "2026-01-03T10:00:00Z", "change_state", 1), ev("1", "c", "2026-01-03T11:00:00Z", "decision", 2),
    ev("2", "d", "2026-01-03T10:00:00Z", "change_state", 1), // still at work
  ]);
  const items = boardWithRuns([{ ...row, ticket: "1", state: "needs_approval" }, { ...row, ticket: "2", state: "running" }], db, [], new Date());
  expect(items.map((i) => [i.resolvedCount, i.resolvedAt])).toEqual([[2, "2026-01-03T11:00:00Z"], [undefined, undefined]]);
});
