import { expect, test } from "vitest";
import { LOCAL_MAX, localPath, localSection } from "./local-instructions";

test("missing or blank text gives no section", () => {
  expect(localSection(undefined)).toBe("");
  expect(localSection("  \n")).toBe("");
});
test("the section names the maintainers and keeps the text", () => {
  const s = localSection("Use pnpm.");
  expect(s).toContain("maintainers");
  expect(s).toContain("cannot override");
  expect(s).toContain("Use pnpm.");
});
test("text over the limit is cut to exactly 8,000 characters", () => {
  const s = localSection("x".repeat(9000));
  expect(LOCAL_MAX).toBe(8000);
  expect(s.endsWith("x".repeat(8000))).toBe(true);
  expect(s).not.toContain("x".repeat(8001));
});
test("each role reads its own file", () => {
  expect(localPath("author")).toBe(".factory/author.md");
  expect(localPath("review")).toBe(".factory/review.md");
  expect(localPath("writer")).toBe(".factory/writer.md");
});
