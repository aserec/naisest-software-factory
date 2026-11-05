import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery } from "@/components/test-utils";
import DispatchesPage from "./page";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const d = (o: Record<string, unknown>) => ({ id: String(o.key), target: "demo", source: "pip-audit", title: "2 vulnerable packages", details: "", at: hoursAgo(1), ...o });

test("groups the dispatches by target and shows each one's state and work item", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json([
    { target: "demo", dispatches: [d({ key: "waits" }), d({ key: "started", startedAt: hoursAgo(1) }), d({ key: "done", startedAt: hoursAgo(2), doneAt: hoursAgo(2), workItem: "https://gl/issues/7", at: hoursAgo(2) })] },
    { target: "empty", dispatches: [] },
    { target: "web", dispatches: [d({ key: "package.json", target: "web", source: "npm-audit", title: "old react", link: "https://ci/1" })] },
  ])));
  renderWithQuery(<DispatchesPage />);
  const demo = (await screen.findByRole("heading", { name: "demo" })).closest("section")!;
  const rows = within(demo).getAllByRole("row").slice(1);
  expect(rows.map((r) => [...r.querySelectorAll("td")].map((c) => c.textContent))).toEqual([
    ["pip-audit", "waits", "2 vulnerable packages", "Waiting", "—", "1 h ago"],
    ["pip-audit", "started", "2 vulnerable packages", "Run started", "—", "1 h ago"],
    ["pip-audit", "done", "2 vulnerable packages", "Done", "Open", "2 h ago"],
  ]);
  expect(within(rows[2]).getByRole("link", { name: "Open" }).getAttribute("href")).toBe("https://gl/issues/7");
  // The dispatch's own link (e.g. the failed CI job) is on what it asks for.
  expect(screen.getByRole("link", { name: "old react" }).getAttribute("href")).toBe("https://ci/1");
  expect(screen.queryByRole("heading", { name: "empty" })).toBeNull();
  expect(screen.queryByText("No dispatches yet.")).toBeNull();
});

test("a page with no dispatches says so", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json([{ target: "demo", dispatches: [] }])));
  renderWithQuery(<DispatchesPage />);
  expect(await screen.findByText("No dispatches yet.")).toBeTruthy();
  expect(screen.queryByRole("table")).toBeNull();
});
