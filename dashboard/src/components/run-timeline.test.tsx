import { cleanup, fireEvent, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { RunTimeline, useRunEvents } from "./run-timeline";
import { ev, json, renderWithQuery, wrapper } from "./test-utils";

// No test globals, so Testing Library does not clean up by itself.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const start = ev("step_start", "00", { step: "prepare-patch", id: "s1" });
const events = [
  ev("run_start", "00"),
  start,
  ev("tool_call", "01", { step: "prepare-patch", parent: "s1", data: { name: "Edit", input: "a.ts", result: "ok", ms: 12, ok: true } }),
  ev("usage", "02", { step: "prepare-patch", data: { costUsd: 0.25 } }),
  ev("step_end", "03", { step: "prepare-patch", data: { outcome: "next" } }),
  ev("step_start", "04", { step: "code-review" }),
];

test("shows a lane per step, and a click opens that step in the side panel", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ events: [...events].reverse(), cursor: 9 })));
  renderWithQuery(<RunTimeline run="r1" />);
  const lane = await screen.findByRole("button", { name: /prepare-patch/ });
  expect(screen.getByRole("button", { name: /code-review/ }).textContent).toContain("running");
  expect(lane.textContent).toContain("next");
  expect(lane.textContent).toContain("$0.25");
  expect(screen.queryByText("Edit")).toBeNull();
  fireEvent.click(lane);
  const panel = await screen.findByRole("dialog");
  expect(panel.textContent).toContain("prepare-patch");
  expect(panel.textContent).toContain("Edit");
  expect(window.location.search).toBe("?step=s1");
  fireEvent.click(screen.getByRole("button", { name: /code-review/ })); // the panel stays open and swaps to the other step
  expect((await screen.findByRole("dialog")).textContent).toContain("code-review");
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(window.location.search).toBe("");
});

test("the events hook asks after the cursor it got and appends the answer", async () => {
  const fetchFn = vi.fn()
    .mockResolvedValueOnce(json({ events: events.slice(0, 2), cursor: 3 }))
    .mockResolvedValueOnce(json({ events: events.slice(2), cursor: 6 }));
  vi.stubGlobal("fetch", fetchFn);
  const { result } = renderHook(() => useRunEvents("r1"), { wrapper });
  await waitFor(() => expect(result.current.data).toHaveLength(2));
  expect(fetchFn.mock.calls[0][0]).toBe("/api/events?run=r1&after=0");
  await result.current.refetch();
  expect(fetchFn.mock.calls[1][0]).toBe("/api/events?run=r1&after=3");
  await waitFor(() => expect(result.current.data).toHaveLength(events.length));
});

test("marks a running lane past its limit as Stuck, and not a recent one or an ended one", async () => {
  const old = new Date(Date.now() - 121 * 60_000).toISOString();
  const recent = new Date(Date.now() - 60_000).toISOString();
  const lane = (step: string, at: string) => ({ ...ev("step_start", "00", { step }), at });
  vi.stubGlobal("fetch", vi.fn(async () => json({ events: [lane("prepare-patch", old), lane("code-review", recent), lane("triage", old), { ...ev("step_end", "00", { step: "triage", data: { outcome: "next" } }), at: recent }], cursor: 4 })));
  renderWithQuery(<RunTimeline run="r1" limits={{ "prepare-patch": 120, "code-review": 20, triage: 5 }} />);
  expect((await screen.findByRole("button", { name: /prepare-patch/ })).textContent).toContain("Stuck");
  expect(screen.getByRole("button", { name: /code-review/ }).textContent).not.toContain("Stuck");
  expect(screen.getByRole("button", { name: /triage/ }).textContent).not.toContain("Stuck");
});
