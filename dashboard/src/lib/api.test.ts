import { afterEach, expect, test, vi } from "vitest";
import { api } from "./api";

afterEach(() => vi.unstubAllGlobals());

test("a 401 sends the user to sign-in; other answers come back as they are", async () => {
  const assign = vi.fn();
  vi.stubGlobal("window", { location: { assign } });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
  await expect(api("/api/board")).rejects.toThrow(/Sign in/);
  expect(assign).toHaveBeenCalledWith("/sign-in");
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
  expect((await api("/api/board")).status).toBe(500);
  expect(assign).toHaveBeenCalledTimes(1);
});
