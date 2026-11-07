import { afterEach, expect, it, vi } from "vitest";

const loops = vi.hoisted(() => ({ stops: vi.fn(async () => {}), dispatches: vi.fn(async () => {}) }));
vi.mock("./server/loop", () => ({ loops, report: (...a: unknown[]) => console.error(...a) }));
vi.mock("./server/db-instance", () => ({ getDb: () => ({}) }));
vi.mock("./server/compose", () => ({ getCi: () => ({}) }));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  loops.stops.mockReset();
  loops.dispatches.mockReset();
});

it("runs each part every 10 s on the Node runtime, and keeps going after an error", async () => {
  vi.useFakeTimers();
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.spyOn(console, "error").mockImplementation(() => {});
  loops.stops.mockRejectedValueOnce(new Error("boom"));
  const { register } = await import("./instrumentation");
  await register();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(loops.stops).toHaveBeenCalledTimes(2);
  expect(loops.dispatches).toHaveBeenCalledTimes(2);
});

it("keeps running the other parts while one part hangs, and never overlaps the hung one", async () => {
  vi.useFakeTimers();
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  loops.stops.mockImplementation(() => new Promise(() => {}));
  const { register } = await import("./instrumentation");
  await register();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(loops.stops).toHaveBeenCalledTimes(1);
  expect(loops.dispatches).toHaveBeenCalledTimes(3);
});

it("starts nothing on the edge runtime", async () => {
  vi.useFakeTimers();
  vi.stubEnv("NEXT_RUNTIME", "edge");
  const { register } = await import("./instrumentation");
  await register();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(loops.stops).not.toHaveBeenCalled();
});
