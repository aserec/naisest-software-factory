import { describe, expect, it } from "vitest";
import { changeBranchPrefix, ticketOfBranch } from "./seams";

describe("ticketOfBranch", () => {
  it("reads numeric and non-numeric refs", () => {
    expect(ticketOfBranch("factory/12-fix-login")).toBe("12");
    expect(ticketOfBranch("factory/ABC-12--fix-login")).toBe("ABC-12");
  });
  it("ignores branches the factory did not name", () => {
    expect(ticketOfBranch("factory/ABC-12-fix")).toBeUndefined();
    expect(ticketOfBranch("main")).toBeUndefined();
  });
});

describe("changeBranchPrefix", () => {
  it("keeps today's format for digits and adds a double dash otherwise", () => {
    expect(changeBranchPrefix("12")).toBe("factory/12-");
    expect(changeBranchPrefix("ABC-12")).toBe("factory/ABC-12--");
  });
  it("does not match a longer ref", () => {
    expect("factory/123-x".startsWith(changeBranchPrefix("12"))).toBe(false);
    expect("factory/ABC-120--x".startsWith(changeBranchPrefix("ABC-12"))).toBe(false);
  });
  it.each(["a/b", "x--y", "a b", ""])("rejects %j", (ref) => {
    expect(() => changeBranchPrefix(ref)).toThrow();
  });
  it.each(["7", "PROJ-7"])("round trips %s", (ref) => {
    expect(ticketOfBranch(changeBranchPrefix(ref) + "slug")).toBe(ref);
  });
});
