import { describe, expect, it } from "vitest";
import { MAX_FIELD, runEvent, SWITCHES } from "./run-events.js";

const base = {
  id: "7b1f5a0e-3c1d-4b6e-9a53-0a1f6f3f9c11",
  run: "5d2c1c8e-0b43-4e43-8f0e-6a2f4a1d7e21",
  at: "2026-10-29T10:00:00.000Z",
  target: "demo",
  ticket: "demo#1",
};
const toolCall = { name: "read", input: "a.ts", result: "ok", ms: 12, ok: true };

describe("runEvent", () => {
  it("accepts a valid tool_call", () => {
    expect(runEvent.safeParse({ ...base, type: "tool_call", data: toolCall }).success).toBe(true);
  });

  it("names data.ms when it is missing", () => {
    const { ms: _ms, ...data } = toolCall;
    const r = runEvent.safeParse({ ...base, type: "tool_call", data });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path.join("."))).toContain("data.ms");
  });

  it("rejects an unknown type", () => {
    expect(runEvent.safeParse({ ...base, type: "nope", data: {} }).success).toBe(false);
  });

  it("rejects an input longer than MAX_FIELD", () => {
    const data = { ...toolCall, input: "x".repeat(MAX_FIELD + 1) };
    expect(runEvent.safeParse({ ...base, type: "tool_call", data }).success).toBe(false);
  });

  it("rejects a bad run_end outcome", () => {
    expect(runEvent.safeParse({ ...base, type: "run_end", data: { outcome: "x" } }).success).toBe(false);
  });
});

it("has 7 switches", () => {
  expect(SWITCHES).toHaveLength(7);
});
