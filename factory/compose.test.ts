import { expect, test } from "vitest";
import { commentOnce } from "./compose";
import { fakeCodeHost } from "./fakes";

test("commentOnce skips a comment that repeats the newest one, and posts it again after a person writes", async () => {
  const fake = fakeCodeHost();
  const host = commentOnce(fake);
  const { ref } = await host.openChange("factory/8-x", "A", "t", "8");
  await host.commentChange(ref, "Merging");
  await host.commentChange(ref, "Merging");
  expect(fake.mrComments).toEqual(["Merging"]);
  fake.sayOnChange(ref, "ann", "why?");
  await host.commentChange(ref, "Merging");
  await host.commentChange(ref, "Other");
  expect(fake.mrComments).toEqual(["Merging", "Merging", "Other"]);
});
