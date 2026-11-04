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
  const lane = await screen.findByRole("button", { name: /Prepare patch/ });
  const live = screen.getByRole("button", { name: /Code review/ });
  expect(live.textContent).toContain("running");
  expect(live.textContent).toContain("—"); // no usage yet, so no cost yet
  expect(live.textContent).not.toContain("$0.00");
  expect(lane.textContent).toContain("passed");
  expect(lane.textContent).toContain("$0.25");
  expect(screen.queryByText("Edit")).toBeNull();
  fireEvent.click(lane);
  const panel = await screen.findByRole("dialog");
  expect(panel.textContent).toContain("Prepare patch");
  expect(panel.textContent).toContain("Edit");
  expect(window.location.search).toBe("?step=s1");
  fireEvent.click(screen.getByRole("button", { name: /Code review/ })); // the panel stays open and swaps to the other step
  expect((await screen.findByRole("dialog")).textContent).toContain("Code review");
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
  expect((await screen.findByRole("button", { name: /Prepare patch/ })).textContent).toContain("Stuck");
  expect(screen.getByRole("button", { name: /Code review/ }).textContent).not.toContain("Stuck");
  expect(screen.getByRole("button", { name: /Triage/ }).textContent).not.toContain("Stuck");
});

test("a running step and the run's time count to now, not to the last event", async () => {
  const at = new Date(Date.now() - 5 * 60_000).toISOString();
  vi.stubGlobal("fetch", vi.fn(async () => json({ events: [{ ...ev("run_start", "00"), at }, { ...ev("step_start", "00", { step: "code-review" }), at }], cursor: 2 })));
  renderWithQuery(<RunTimeline run="r1" />);
  expect((await screen.findByRole("button", { name: /Code review/ })).textContent).toContain("5 m");
  expect(screen.getByText("Time").nextElementSibling?.textContent).toBe("5 m");
});

test("the Risk figure shows the triage and merge risk, and a dash before triage", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ events, cursor: 9 })));
  renderWithQuery(<RunTimeline run="r1" risk={{ risk: "medium", mergeRisk: 6 }} />);
  expect(await screen.findByText("Triage risk medium")).toBeTruthy();
  expect(screen.getByText("Merge risk 6/10, limit 4").getAttribute("data-variant")).toBe("warning");
  cleanup();
  renderWithQuery(<RunTimeline run="r1" />);
  const figure = (await screen.findByText("Risk")).parentElement!;
  expect(figure.textContent).toBe("Risk—");
});

test("the line shows all ten steps: the ones not reached are listed after the live one, and Now says how far the run is", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ events, cursor: 9 })));
  renderWithQuery(<RunTimeline run="r1" />);
  await screen.findByRole("button", { name: /Code review/ });
  const ahead = screen.getAllByText(/not reached/).map((e) => e.parentElement!.textContent);
  expect(ahead).toEqual(["Precommit gate", "Risk check", "Decision", "Apply", "Verify", "Result saved"].map((s) => `${s} not reached`));
  expect(screen.getByText("Now").nextElementSibling?.textContent).toBe("Code review4 of 10");
});

test("a run that waits for approval says so in Now, and Proof shows the review, the last result of each check, and why it waits", async () => {
  const proof = [
    ev("run_start", "00"),
    ev("review_finding", "01", { step: "code-review", data: { text: "a", blocking: true, round: 1 } }),
    ev("review_finding", "02", { step: "code-review", data: { text: "b", blocking: false, round: 2 } }),
    ev("gate_check", "03", { step: "precommit-gate", data: { command: "pnpm test", exitCode: 1, outputTail: "" } }),
    ev("gate_check", "04", { step: "precommit-gate", data: { command: "pnpm test", exitCode: 0, outputTail: "" } }),
    ev("gate_check", "04", { step: "precommit-gate", data: { command: "pnpm lint", exitCode: 1, outputTail: "" } }),
    ev("step_start", "05", { step: "decision" }),
    ev("decision", "06", { step: "decision", data: { auto: false, reasons: ["merge risk 6 is above the limit of 4"] } }),
    ev("step_end", "06", { step: "decision", data: { outcome: "stop" } }),
  ];
  vi.stubGlobal("fetch", vi.fn(async () => json({ events: proof, cursor: 9 })));
  renderWithQuery(<RunTimeline run="r1" state="factory_needs_approval" />);
  const fact = async (label: string) => (await screen.findByText(label, { selector: "dt" })).nextElementSibling?.textContent;
  expect(await fact("Review")).toBe("Round 2, 0 of 1 finding blocking");
  expect(await fact("Checks")).toBe("1 of 2 passed");
  expect(await fact("Decision")).toBe("Waits for a person, because merge risk 6 is above the limit of 4.");
  expect(screen.getByText("Now").nextElementSibling?.textContent).toBe("Waits for you7 of 10");
  // The factory ends the decision step with "stop"; the pill names what the run waits for.
  expect(screen.getByRole("button", { name: /Decision/ }).textContent).toContain("needs approval");
});

test("Proof names the review, checks and rules the run did not send, so a missing proof is not hidden", async () => {
  const only = [ev("run_start", "00"), ev("step_start", "01", { step: "decision" }), ev("decision", "01", { step: "decision", data: { auto: false, reasons: ["merge risk 6 is above the limit of 4"] } })];
  vi.stubGlobal("fetch", vi.fn(async () => json({ events: only, cursor: 2 })));
  renderWithQuery(<RunTimeline run="r1" />);
  const fact = async (label: string) => (await screen.findByText(label, { selector: "dt" })).nextElementSibling?.textContent;
  expect([await fact("Review"), await fact("Checks"), await fact("Rules")]).toEqual(["None sent", "None sent", "None sent"]);
});

test("a failed poll keeps the steps on screen under the error", async () => {
  let fail = false;
  vi.stubGlobal("fetch", vi.fn(async () => (fail ? new Response("", { status: 500 }) : json({ events, cursor: 9 }))));
  renderWithQuery(<RunTimeline run="r1" />);
  await screen.findByRole("button", { name: /Prepare patch/ });
  fail = true;
  expect((await screen.findByRole("alert", {}, { timeout: 3000 })).textContent).toMatch(/^Could not load the run\. Showing it as of /);
  expect(screen.getByRole("button", { name: /Prepare patch/ })).toBeTruthy();
});

test("a run with no proof events shows no Proof section", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ events: [ev("step_start", "00", { step: "triage" })], cursor: 1 })));
  renderWithQuery(<RunTimeline run="r1" />);
  await screen.findByRole("button", { name: /Triage/ });
  expect(screen.queryByRole("heading", { name: "Proof" })).toBeNull();
});

test("opening a step moves focus to the panel title, and Esc brings it back to that step's row", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ events, cursor: 9 })));
  renderWithQuery(<RunTimeline run="r1" />);
  const lane = await screen.findByRole("button", { name: /Prepare patch/ });
  lane.focus();
  fireEvent.click(lane);
  const panel = await screen.findByRole("dialog");
  await waitFor(() => expect(document.activeElement).toBe(panel.querySelector("h2")));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(lane);
});
