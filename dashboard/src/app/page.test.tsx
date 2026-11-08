import { afterEach, expect, test, vi } from "vitest";
import Home from "./page";

vi.mock("@/server/auth", () => ({ sessionUser: async () => undefined }));
vi.mock("@/server/insights-load", () => ({ loadInsights: () => ({}) }));
vi.mock("@/server/preferences", () => ({ readPrefs: () => ({}) }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`redirect ${to}`); } }));

afterEach(() => vi.unstubAllEnvs());

test("an old ?target= link opens that target's board", async () => {
  vi.stubEnv("TARGETS_DIR", "e2e/targets");
  await expect(Home({ searchParams: Promise.resolve({ target: "demo" }) })).rejects.toThrow("redirect /boards/demo");
});
