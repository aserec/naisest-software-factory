import { expect, test } from "vitest";
import { fakeTracker } from "../fakes";
import { trackerContract } from "./tracker.contract";

trackerContract(async () => ({ tracker: fakeTracker([{ ref: "1", title: "T" }]), ref: "1" }));

test("fake tracker records the cleared tickets", async () => {
  const tracker = fakeTracker([{ ref: "1", state: "running" }]);
  await tracker.clearState("1");
  expect(tracker.cleared).toEqual(["1"]);
  expect((await tracker.ticket("1")).state).toBeUndefined();
});
