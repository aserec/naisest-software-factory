import { fireEvent, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { RunTimeline, useRunEvents } from "./run-timeline";
import { ev, json, renderWithQuery, wrapper } from "./test-utils";

afterEach(() => vi.unstubAllGlobals());

const start = ev("step_start", "00", { step: "prepare-patch", id: "s1" });
const events = [
  ev("run_start", "00"),
  start,
  ev("tool_call", "01", { step: "prepare-patch", parent: "s1", data: { name: "Edit", input: "a.ts", result: "ok", ms: 12, ok: true } }),
  ev("usage", "02", { step: "prepare-patch", data: { costUsd: 0.25 } }),
  ev("step_end", "03", { step: "prepare-patch", data: { outcome: "next" } }),
  ev("step_start", "04", { step: "code-review" }),
];

test("shows a lane per step and the tool calls only after a click", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ events: [...events].reverse(), cursor: 9 })));
  renderWithQuery(<RunTimeline run="r1" />);
  const lane = await screen.findByRole("button", { name: /prepare-patch/ });
  expect(screen.getByRole("button", { name: /code-review/ }).textContent).toContain("running");
  expect(lane.textContent).toContain("next");
  expect(lane.textContent).toContain("$0.25");
  expect(screen.queryByText("Edit")).toBeNull();
  fireEvent.click(lane);
  expect(screen.getByText("Edit")).toBeTruthy();
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
