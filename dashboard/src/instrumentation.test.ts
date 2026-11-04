import { afterEach, expect, it, vi } from "vitest";

const tick = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./server/loop", () => ({ tick }));
vi.mock("./server/db-instance", () => ({ getDb: () => ({}) }));
vi.mock("./server/compose", () => ({ getCi: () => ({}) }));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  tick.mockClear();
});

it("runs tick every 10 s on the Node runtime, and keeps going after an error", async () => {
  vi.useFakeTimers();
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.spyOn(console, "error").mockImplementation(() => {});
  tick.mockRejectedValueOnce(new Error("boom"));
  const { register } = await import("./instrumentation");
  await register();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(tick).toHaveBeenCalledTimes(2);
});

it("starts nothing on the edge runtime", async () => {
  vi.useFakeTimers();
  vi.stubEnv("NEXT_RUNTIME", "edge");
  const { register } = await import("./instrumentation");
  await register();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(tick).not.toHaveBeenCalled();
});
