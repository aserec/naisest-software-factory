import { expect, test } from "vitest";
import { decideStart } from "./event.js";
import type { FactoryEvent } from "./seams";

const e: FactoryEvent = { kind: "ready", ticket: "8", actor: "devone" };

test("ready set by a trusted person starts a run", () => {
  expect(decideStart(e, { actorTrusted: true, state: "ready", runningInRepo: 0 })).toEqual({ start: true });
});
test("an event that is not a ready event does not start a run", () => {
  expect(decideStart({ kind: "ignored", reason: "not-added" }, { actorTrusted: true, state: "ready", runningInRepo: 0 })).toEqual({ start: false, reason: "not-added" });
});
test("people who may not command the factory cannot start runs", () => {
  expect(decideStart(e, { actorTrusted: false, state: "ready", runningInRepo: 0 })).toEqual({ start: false, reason: "not-member" });
});
test("a second event during a run is ignored", () => {
  expect(decideStart(e, { actorTrusted: true, state: "running", runningInRepo: 1 })).toEqual({ start: false, reason: "active-run" });
});
test("a third run in the same repo waits", () => {
  expect(decideStart(e, { actorTrusted: true, state: "ready", runningInRepo: 2 })).toEqual({ start: false, reason: "repo-full" });
});
test("ready again while waiting is an active run", () => {
  expect(decideStart(e, { actorTrusted: true, state: "waiting", runningInRepo: 0 })).toEqual({ start: false, reason: "active-run" });
});
test("an untrusted person on a ticket with an active run gets not-member", () => {
  expect(decideStart(e, { actorTrusted: false, state: "running", runningInRepo: 0 })).toEqual({ start: false, reason: "not-member" });
});
test("a start needs the ready state read live, not only the event", () => {
  expect(decideStart(e, { actorTrusted: true, state: "needs_info", runningInRepo: 0 })).toEqual({ start: false, reason: "not-ready" });
  expect(decideStart(e, { actorTrusted: true, runningInRepo: 0 })).toEqual({ start: false, reason: "not-ready" });
});
