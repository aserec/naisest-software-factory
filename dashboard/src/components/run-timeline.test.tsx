import { act, cleanup, fireEvent, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { RunTimeline, useRunEvents } from "./run-timeline";
import { ev, renderWithQuery, wrapper } from "./test-utils";

// No test globals, so Testing Library does not clean up by itself.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// A stand-in for the browser's EventSource: it sends the given batches, and a test can send more or close it.
class FakeSource {
  static CLOSED = 2;
  static last: FakeSource;
  static batches: unknown[][] = [];
  readyState = 1;
  onmessage?: (m: { data: string }) => void;
  onerror?: () => void;
  ends: (() => void)[] = [];
  constructor(public url: string) {
    FakeSource.last = this;
    queueMicrotask(() => FakeSource.batches.forEach((b) => this.send(b)));
  }
  send = (events: unknown[]) => act(() => this.onmessage?.({ data: JSON.stringify(events) }));
  addEventListener = (type: string, f: () => void) => type === "end" && this.ends.push(f);
  close = () => (this.readyState = 2);
  fail = () => act(() => ((this.readyState = 2), this.onerror?.()));
}
const stream = (...batches: unknown[][]) => {
  FakeSource.batches = batches;
  vi.stubGlobal("EventSource", FakeSource);
};

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
  stream([...events].reverse());
  renderWithQuery(<RunTimeline run="r1" />);
  const lane = await screen.findByRole("button", { name: /Implement/ });
  const live = screen.getByRole("button", { name: /Code review/ });
  expect(live.textContent).toContain("running");
  expect(live.textContent).toContain("—"); // no usage yet, so no cost yet
  expect(live.textContent).not.toContain("$0.00");
  expect(lane.textContent).toContain("passed");
  expect(lane.textContent).toContain("$0.25");
  expect(screen.queryByText("Edit")).toBeNull();
  fireEvent.click(lane);
  const panel = await screen.findByRole("dialog");
  expect(panel.textContent).toContain("Implement");
  expect(panel.textContent).toContain("Edit");
  expect(window.location.search).toBe("?step=s1");
  fireEvent.click(screen.getByRole("button", { name: /Code review/ })); // the panel stays open and swaps to the other step
  expect((await screen.findByRole("dialog")).textContent).toContain("Code review");
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(window.location.search).toBe("");
});

test("a press on another row swaps the side panel, and a press elsewhere closes it", async () => {
  stream(events);
  renderWithQuery(<RunTimeline run="r1" />);
  fireEvent.click(await screen.findByRole("button", { name: /Implement/ }));
  await screen.findByRole("dialog");
  await new Promise((r) => setTimeout(r)); // Radix listens for outside presses from the next tick
  const other = screen.getByRole("button", { name: /Code review/ });
  fireEvent.pointerDown(other);
  fireEvent.click(other);
  expect((await screen.findByRole("dialog")).textContent).toContain("Code review");
  fireEvent.pointerDown(document.body); // Radix acts on the click that follows the press
  fireEvent.click(document.body);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("the events hook streams the run, appends each batch, closes on end, and a retry opens it after the last event held", async () => {
  stream(events.slice(0, 2));
  const { result } = renderHook(() => useRunEvents("r1"), { wrapper });
  await waitFor(() => expect(result.current.data).toHaveLength(2));
  const first = FakeSource.last;
  expect(first.url).toBe("/api/events/stream?run=r1&after=0");
  await first.send(events.slice(2));
  await waitFor(() => expect(result.current.data).toEqual(events));
  first.ends.forEach((f) => f());
  expect(first.readyState).toBe(FakeSource.CLOSED);
  await first.fail(); // a stream the browser gave up on is an error, and the events stay
  expect(result.current.error).toBeTruthy();
  expect(result.current.data).toHaveLength(events.length);
  stream();
  act(() => void result.current.refetch());
  await waitFor(() => expect(FakeSource.last).not.toBe(first));
  expect(FakeSource.last.url).toBe(`/api/events/stream?run=r1&after=${events.at(-1)!.seq}`);
  expect(result.current.error).toBeUndefined();
});

test("marks the running step past its limit as Stuck, and not a recent one, an ended one or one of a paused run", async () => {
  const old = new Date(Date.now() - 121 * 60_000).toISOString();
  const recent = new Date(Date.now() - 60_000).toISOString();
  const lane = (step: string, at: string) => ({ ...ev("step_start", "00", { step }), at });
  const end = (step: string) => ({ ...ev("step_end", "00", { step, data: { outcome: "next" } }), at: recent });
  const limits = { "prepare-patch": 120, "code-review": 20 };
  const run = async (events: unknown[], state?: "stopped") => {
    stream(events);
    renderWithQuery(<RunTimeline run="r1" limits={limits} state={state} />);
    return (await screen.findByRole("button", { name: /Implement|Code review/ })).textContent;
  };
  expect(await run([lane("prepare-patch", old)])).toContain("Stuck");
  cleanup();
  expect(await run([lane("code-review", recent)])).not.toContain("Stuck");
  cleanup();
  expect(await run([lane("prepare-patch", old), end("prepare-patch")])).not.toContain("Stuck");
  cleanup();
  expect(await run([lane("prepare-patch", old)], "stopped")).not.toContain("Stuck");
});

test("the Stuck badge sits on the run's last step, not on an earlier lane that never ended", async () => {
  const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const events = [{ ...ev("step_start", "00", { step: "prepare-patch" }), at: at(200) }, { ...ev("step_start", "01", { step: "code-review" }), at: at(30) }];
  stream(events);
  renderWithQuery(<RunTimeline run="r1" limits={{ "prepare-patch": 120, "code-review": 20 }} />);
  expect((await screen.findByRole("button", { name: /Code review/ })).textContent).toContain("Stuck");
  expect(screen.getByRole("button", { name: /Implement/ }).textContent).not.toContain("Stuck");
});

test("a running step and the run's time count to now, not to the last event", async () => {
  const at = new Date(Date.now() - 5 * 60_000).toISOString();
  stream([{ ...ev("run_start", "00"), at }, { ...ev("step_start", "00", { step: "code-review" }), at }]);
  renderWithQuery(<RunTimeline run="r1" />);
  expect((await screen.findByRole("button", { name: /Code review/ })).textContent).toContain("5 m");
  expect(screen.getByText("Time").nextElementSibling?.textContent).toBe("5 m");
});

test("the Risk figure shows the triage and merge risk, and a dash before triage", async () => {
  stream(events);
  renderWithQuery(<RunTimeline run="r1" risk={{ risk: "medium", mergeRisk: 6 }} />);
  expect(await screen.findByText("Triage risk medium")).toBeTruthy();
  expect(screen.getByText("Merge risk 6/10, limit 4").getAttribute("data-variant")).toBe("warning");
  cleanup();
  renderWithQuery(<RunTimeline run="r1" />);
  const figure = (await screen.findByText("Risk")).parentElement!;
  expect(figure.textContent).toBe("Risk—");
});

test("the line shows all ten steps: the ones not reached are listed after the live one, and Now says how far the run is", async () => {
  stream(events);
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
  stream(proof);
  renderWithQuery(<RunTimeline run="r1" state="needs_approval" />);
  const fact = async (label: string) => (await screen.findByText(label, { selector: "dt" })).nextElementSibling?.textContent;
  expect(await fact("Review")).toBe("Round 2, 0 of 1 finding blocking");
  expect(await fact("Checks")).toBe("1 of 2 passed");
  // Waiting for a merge, a missing proof is a warning with what to do instead.
  expect(await fact("Rules")).toBe("The run sent no rule results. Look at the changed files before you merge.");
  expect(screen.getByRole("heading", { name: "Waits for you because" }).nextElementSibling?.textContent).toBe("Merge risk 6 is above the limit of 4");
  expect(screen.queryByText("Decision", { selector: "dt" })).toBeNull(); // said once, under the title
  // Time is the factory's six minutes; the wait for a person since the last event counts apart.
  expect(screen.getByText("Time").nextElementSibling?.textContent).toMatch(/^6 mthen waiting \d/);
  expect(screen.getByText("Now").nextElementSibling?.textContent).toBe("Waits for you7 of 10");
  // The run's record starts at decision; the six steps before it still show, marked as having no events here.
  expect(screen.getAllByText(/, no events in this run$/).map((e) => e.parentElement?.textContent)).toEqual(
    ["Event", "Triage", "Implement", "Code review", "Precommit gate", "Risk check"].map((s) => `${s}, no events in this run`),
  );
  // The factory ends the decision step with "stop"; the pill names what the run waits for.
  expect(screen.getByRole("button", { name: /Decision/ }).textContent).toContain("needs approval");
});

test("Proof names the review, checks and rules the run did not send, so a missing proof is not hidden", async () => {
  const only = [ev("run_start", "00"), ev("step_start", "01", { step: "decision" }), ev("decision", "01", { step: "decision", data: { auto: false, reasons: ["merge risk 6 is above the limit of 4"] } })];
  stream(only);
  renderWithQuery(<RunTimeline run="r1" />);
  const fact = async (label: string) => (await screen.findByText(label, { selector: "dt" })).nextElementSibling?.textContent;
  expect([await fact("Review"), await fact("Checks"), await fact("Rules")]).toEqual(["None sent", "None sent", "None sent"]);
  expect(await fact("Decision")).toBe("Waits for a person, because merge risk 6 is above the limit of 4.");
});

test("a closed stream keeps the steps on screen under the error", async () => {
  stream(events);
  renderWithQuery(<RunTimeline run="r1" />);
  await screen.findByRole("button", { name: /Implement/ });
  await FakeSource.last.fail();
  expect((await screen.findByRole("alert")).textContent).toMatch(/^Could not load the run\. Showing it as of /);
  expect(screen.getByRole("button", { name: /Implement/ })).toBeTruthy();
});

test("with a step open, the figures sit in one line of label and value pairs", async () => {
  stream(events);
  renderWithQuery(<RunTimeline run="r1" />);
  const fig = async (label: string) => (await screen.findByText(label, { selector: "dt" })).nextElementSibling?.textContent;
  expect(screen.queryByText("Time", { selector: "dt" })).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: /Implement/ }));
  expect([await fig("Now"), await fig("Risk")]).toEqual(["Code review4 of 10", "—"]);
  window.history.replaceState(null, "", "/"); // the open step lives in the URL
});

test("a run with no proof events shows no Proof section", async () => {
  stream([ev("step_start", "00", { step: "triage" })]);
  renderWithQuery(<RunTimeline run="r1" />);
  await screen.findByRole("button", { name: /Triage/ });
  expect(screen.queryByRole("heading", { name: "Proof" })).toBeNull();
});

test("opening a step moves focus to the panel title, and Esc brings it back to that step's row", async () => {
  stream(events);
  renderWithQuery(<RunTimeline run="r1" />);
  const lane = await screen.findByRole("button", { name: /Implement/ });
  lane.focus();
  fireEvent.click(lane);
  const panel = await screen.findByRole("dialog");
  await waitFor(() => expect(document.activeElement).toBe(panel.querySelector("h2")));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(lane);
});

test("j and k open the next and the previous step, and are left alone while typing in a field", async () => {
  stream(events);
  renderWithQuery(<RunTimeline run="r1" />);
  await screen.findByRole("button", { name: /Implement/ });
  const title = async () => (await screen.findByRole("dialog")).querySelector("h2")!.textContent;
  fireEvent.keyDown(document.body, { key: "j" }); // nothing open: the first step
  expect(await title()).toMatch(/^Implement/);
  fireEvent.keyDown(document.body, { key: "j" });
  await waitFor(async () => expect(await title()).toMatch(/^Code review/));
  fireEvent.keyDown(document.body, { key: "j" }); // the last step stays open
  expect(await title()).toMatch(/^Code review/);
  const field = document.body.appendChild(document.createElement("input"));
  fireEvent.keyDown(field, { key: "k" });
  expect(await title()).toMatch(/^Code review/);
  field.remove();
  fireEvent.keyDown(document.body, { key: "k" });
  await waitFor(async () => expect(await title()).toMatch(/^Implement/));
  expect(window.location.search).toBe("?step=s1");
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("Cost by model shows the run's tokens and cost per role and model, with a total", async () => {
  const usage = (role: string, model: string, n: number, costUsd: number, step: string) => ev("usage", "02", { step, data: { role, model, input: n, output: n * 2, cacheRead: n * 3, cacheWrite: n * 4, costUsd, contextTokens: 0 } });
  stream([...events.filter((e) => e.type !== "usage"), usage("author", "opus", 1000, 1.5, "prepare-patch"), usage("reviewer", "glm", 10, 0, "code-review"), usage("author", "opus", 1000, 0.5, "code-review")]);
  renderWithQuery(<RunTimeline run="r1" />);
  const table = (await screen.findByRole("heading", { name: "Cost by model" })).parentElement!.querySelector("table")!;
  const rows = [...table.querySelectorAll("tr")].map((r) => [...r.children].map((c) => c.textContent));
  expect(rows).toEqual([
    ["Role and model", "Input", "Output", "Cache read", "Cache write", "Cost"],
    ["author · opus", "2,000", "4,000", "6,000", "8,000", "$2.00"],
    ["reviewer · glm", "10", "20", "30", "40", "$0.00"],
    ["Total", "2,010", "4,020", "6,030", "8,040", "$2.00"],
  ]);
  expect(document.body.textContent).toContain("Without glm: seams.yml sets no price for it");
});

test("Earlier runs lists the work item's other runs with a link each, and is hidden when there are none", async () => {
  stream(events);
  const earlier = [
    { run: "r0", target: "t", ticket: "7", startedAt: "2026-10-28T09:00:00Z", outcome: "blocked", costUsd: 3.2, lastStep: { step: "code-review", startedAt: "", ended: true } },
    { run: "r-1", target: "t", ticket: "7", startedAt: "2026-10-27T09:00:00Z", costUsd: 0 },
  ];
  renderWithQuery(<RunTimeline run="r1" earlier={earlier} />);
  const table = (await screen.findByRole("heading", { name: "Earlier runs" })).parentElement!.querySelector("table")!;
  const rows = [...table.querySelectorAll("tbody tr")].map((r) => [...r.children].slice(1).map((c) => c.textContent));
  expect(rows).toEqual([
    ["blocked", "Code review", "r0", "$3.20"],
    ["not ended", "—", "r-1", "$0.00"],
  ]);
  expect(table.querySelector("tbody td")!.textContent).toContain("2026");
  expect(screen.getByRole("link", { name: "r0" }).getAttribute("href")).toBe("/runs/r0");
  cleanup();
  stream(events);
  renderWithQuery(<RunTimeline run="r1" />);
  await screen.findByRole("button", { name: /Implement/ });
  expect(screen.queryByRole("heading", { name: "Earlier runs" })).toBeNull();
});
