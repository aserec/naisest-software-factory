import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { decideStart, parseLabelEvent, parseMergeRequestEvent } from "./event.js";

const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

test("label just added by a developer starts a run", () => {
  const e = parseLabelEvent(load("label-added.json"))!;
  expect(e).toMatchObject({ projectPath: "acme/web/react_frontend", workItemIid: 8, actorId: 42, labelsBefore: [], labelsAfter: ["factory_ready"] });
  expect(decideStart(e, { actorAccessLevel: 30, workItemLabels: ["factory_ready"], runningInRepo: 0 })).toEqual({ start: true });
});
test("other edits do not start a run", () => {
  expect(parseLabelEvent(load("label-unchanged.json"))).toBeNull();
});
test("work_item events work too", () => {
  expect(parseLabelEvent({ ...load("label-added.json"), object_kind: "work_item" })).not.toBeNull();
});
test("label that was already there is not new", () => {
  const p = load("label-added.json");
  p.changes.labels.previous = [{ title: "factory_ready" }];
  expect(parseLabelEvent(p)).toBeNull();
});
test("reporters cannot start runs", () => {
  const e = parseLabelEvent(load("label-added.json"))!;
  expect(decideStart(e, { actorAccessLevel: 20, workItemLabels: ["factory_ready"], runningInRepo: 0 })).toEqual({ start: false, reason: "not-member" });
});
test("a second event during a run is ignored", () => {
  const e = parseLabelEvent(load("label-added.json"))!;
  expect(decideStart(e, { actorAccessLevel: 30, workItemLabels: ["factory_ready", "factory_running"], runningInRepo: 1 })).toEqual({ start: false, reason: "active-run" });
});
test("a third run in the same repo waits", () => {
  const e = parseLabelEvent(load("label-added.json"))!;
  expect(decideStart(e, { actorAccessLevel: 30, workItemLabels: ["factory_ready"], runningInRepo: 2 })).toEqual({ start: false, reason: "repo-full" });
});
test("re-added label while waiting is an active run", () => {
  const e = parseLabelEvent(load("label-added.json"))!;
  expect(decideStart(e, { actorAccessLevel: 30, workItemLabels: ["factory_ready", "factory_waiting"], runningInRepo: 0 })).toEqual({ start: false, reason: "active-run" });
});
test("re-added label after needs_info starts a new run", () => {
  const e = parseLabelEvent(load("label-added.json"))!;
  expect(decideStart(e, { actorAccessLevel: 30, workItemLabels: ["factory_ready", "factory_needs_info"], runningInRepo: 0 })).toEqual({ start: true });
});
test("a reporter on a work item with an active run gets not-member", () => {
  const e = parseLabelEvent(load("label-added.json"))!;
  expect(decideStart(e, { actorAccessLevel: 20, workItemLabels: ["factory_ready", "factory_running"], runningInRepo: 0 })).toEqual({ start: false, reason: "not-member" });
});
test("an approval or merge of a factory MR is a merge request event", () => {
  const p = load("mr-approved.json");
  expect(parseMergeRequestEvent(p)).toEqual({ projectPath: "acme/web/react_frontend", mrIid: 5, workItemIid: 8, action: "approved", actorId: 42 });
  p.object_attributes.action = "merge";
  expect(parseMergeRequestEvent(p)).toMatchObject({ action: "merge" });
});
test("other MR actions, other branches and revert branches are ignored", () => {
  const p = load("mr-approved.json");
  expect(parseMergeRequestEvent({ ...p, object_attributes: { ...p.object_attributes, action: "update" } })).toBeNull();
  expect(parseMergeRequestEvent({ ...p, object_attributes: { ...p.object_attributes, source_branch: "feature/8-x" } })).toBeNull();
  expect(parseMergeRequestEvent({ ...p, object_attributes: { ...p.object_attributes, source_branch: "factory/revert-abcdef12-1" } })).toBeNull();
  expect(parseMergeRequestEvent(load("label-added.json"))).toBeNull();
});
test("a label start needs factory_ready in the live labels, not only in the payload", () => {
  const e = parseLabelEvent(load("label-added.json"))!;
  expect(decideStart(e, { actorAccessLevel: 30, workItemLabels: ["factory_needs_info"], runningInRepo: 0 })).toEqual({ start: false, reason: "not-ready" });
});
