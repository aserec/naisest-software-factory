import { describe, expect, it } from "vitest";
import { isStuck } from "./stuck";

const now = new Date("2026-10-29T12:00:00Z");
const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
const limits = { "prepare-patch": 120 };

describe("isStuck", () => {
  it("is stuck only after the limit for prepare-patch", () => {
    expect(isStuck({ step: "prepare-patch", startedAt: ago(119), ended: false }, limits, now)).toBe(false);
    expect(isStuck({ step: "prepare-patch", startedAt: ago(121), ended: false }, limits, now)).toBe(true);
  });

  it("is never stuck when the step ended, has no limit, or there is no step", () => {
    expect(isStuck({ step: "prepare-patch", startedAt: ago(500), ended: true }, limits, now)).toBe(false);
    expect(isStuck({ step: "other", startedAt: ago(500), ended: false }, limits, now)).toBe(false);
    expect(isStuck(undefined, limits, now)).toBe(false);
  });
});
