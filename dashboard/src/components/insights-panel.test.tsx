import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Insights } from "@/server/insights";
import type { InsightsPayload } from "@/server/insights-load";
import { InsightsPanel } from "./insights-panel";
import { json, renderWithQuery } from "./test-utils";

afterEach(() => [cleanup(), vi.unstubAllGlobals()]);

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const data = (runs: number): Insights => ({
  unit: "day", buckets: [], runs, cost: { p50: 1, p95: 1, total: runs }, time: { p50: 60, p95: 60 }, steps: [], targets: [], rounds: [], risk: [], list: [],
});
const payload = (said: string, runs: number): InsightsPayload => ({ data: data(runs), range: "7d", said, tz });

test("a new range loads in place: the page asks /api/insights and rewrites the URL without leaving", async () => {
  const fetch = vi.fn(async (_url: string) => json({ ...payload("Yesterday", 3), range: "yesterday" }));
  vi.stubGlobal("fetch", fetch);
  const replace = vi.spyOn(window.history, "replaceState");
  renderWithQuery(<InsightsPanel initial={payload("Last 7 days", 5)} hasZone />);
  expect(screen.getByText(/^Last 7 days, every target/)).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled(); // the server already rendered this range
  fireEvent.change(screen.getByLabelText("Range"), { target: { value: "yesterday" } });
  await waitFor(() => expect(screen.getByText(/^Yesterday, every target/)).toBeTruthy());
  expect(String(fetch.mock.calls[0][0])).toBe(`/api/insights?${new URLSearchParams({ range: "yesterday", tz })}`);
  expect(replace).toHaveBeenLastCalledWith(null, "", `?${new URLSearchParams({ range: "yesterday", tz })}`);
});

test("a first visit with no time zone in the URL asks again in the viewer's own", async () => {
  const fetch = vi.fn(async (_url: string) => json(payload("Last 7 days", 2)));
  vi.stubGlobal("fetch", fetch);
  renderWithQuery(<InsightsPanel initial={{ ...payload("Last 7 days", 5), tz: "UTC" }} hasZone={false} />);
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  expect(String(fetch.mock.calls[0][0])).toContain(`tz=${encodeURIComponent(tz)}`);
});
