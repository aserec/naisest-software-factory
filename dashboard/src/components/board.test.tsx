import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ago, duration } from "@/lib/utils";
import { Board, emptyLine, finding, newlyWaiting, RiskPills, type BoardItem } from "./board";
import { json, renderWithQuery } from "./test-utils";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
  localStorage.clear();
});

const item = (o: Partial<BoardItem>): BoardItem => ({ target: "demo", ticket: "7", title: "Fix login", state: "running", url: "http://gl/7", updatedAt: "", stuck: false, ...o });

test("renders a section per label that has tickets, one line for the empty ones, and a Stuck badge", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json([item({ run: "r1", costUsd: 1.5, stuck: true }), item({ ticket: "8", title: "Add docs", state: "done" })])));
  renderWithQuery(<Board />);
  expect(await screen.findByText("Fix login")).toBeTruthy();
  expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Waiting on you", "With the factory"]);
  expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Running 1", "Done 1"]); // only labels with tickets
  expect(screen.getByText("Needs approval, Needs info, Stopped and Blocked are empty.")).toBeTruthy();
  expect(screen.getAllByText("Stuck")).toHaveLength(1);
  expect(screen.getByText("$1.50")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Fix login" }).getAttribute("href")).toBe("/runs/r1");
  expect(screen.getByRole("link", { name: "Add docs" }).getAttribute("href")).toBe("http://gl/7"); // no run: links to GitLab
});

test("a card shows the live step, the round and both risks", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json([item({ run: "r1", step: "code-review", round: 2, risk: "low", mergeRisk: 3 })])));
  renderWithQuery(<Board />);
  expect(await screen.findByText(/Code review · round 2/)).toBeTruthy();
  expect(screen.getByText("Triage risk low")).toBeTruthy();
  expect(screen.getByText("Merge risk 3/10, limit 4")).toBeTruthy();
});

test("high triage risk and a merge risk above the limit take the warning pill, the rest stay neutral", () => {
  const variants = (p: Parameters<typeof RiskPills>[0]) => {
    const { container, unmount } = render(<RiskPills {...p} />);
    const v = [...container.querySelectorAll("[data-variant]")].map((b) => b.getAttribute("data-variant"));
    unmount();
    return v;
  };
  expect(variants({ risk: "high", mergeRisk: 5 })).toEqual(["warning", "warning"]);
  expect(variants({ risk: "low", mergeRisk: 4 })).toEqual(["default", "default"]);
  expect(variants({})).toEqual([]);
  // The target's own limit, when the run sent it.
  expect(variants({ mergeRisk: 5, mergeRiskMax: 6 })).toEqual(["default"]);
  render(<RiskPills mergeRisk={5} mergeRiskMax={6} />);
  expect(screen.getByText("Merge risk 5/10, limit 6")).toBeTruthy();
});

test("a failed board load says so in plain words, keeps the last board with its time, and Retry loads it again", async () => {
  let fail = false;
  const fetchMock = vi.fn(async () => (fail ? new Response("", { status: 502 }) : json([item({ title: "Fix login" })])));
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = within(
    render(
      <QueryClientProvider client={client}>
        <Board />
      </QueryClientProvider>,
    ).container,
  );
  await view.findByRole("link", { name: "Fix login" });
  fail = true;
  await client.refetchQueries();
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toMatch(/^Could not load the board\. Showing it as of \d\d:\d\d.*\.Retry$/);
  expect(view.getByRole("link", { name: "Fix login" })).toBeTruthy();
  fail = false;
  const calls = fetchMock.mock.calls.length;
  fireEvent.click(view.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(view.queryByRole("alert")).toBeNull());
  expect(fetchMock.mock.calls.length).toBe(calls + 1);
});

test("the finding names what waits for a person, and says so when nothing does", () => {
  expect(finding([item({ state: "needs_approval" }), item({ state: "needs_info" }), item({ state: "needs_info" }), item({ stuck: true })])).toBe("1 to approve, 2 need an answer, 1 run stuck.");
  expect(finding([item({ state: "done" })])).toBe("Nothing waits for you.");
});

test("durations and ages read as people say them", () => {
  expect([0.25, 42, 540, 545, 8400].map(duration)).toEqual(["250 ms", "42 s", "9 m", "9 m 5 s", "2 h 20 m"]);
  const now = Date.parse("2026-11-01T12:00:00Z");
  expect([ago("2026-11-01T11:59:40Z", now), ago("2026-11-01T11:12:00Z", now), ago("2026-10-30T12:00:00Z", now), ago("", now)]).toEqual(["just now", "48 m ago", "2 d ago", undefined]);
});

test("the empty line names one or many labels, and nothing when none is empty", () => {
  expect(emptyLine(["done"])).toBe("Done is empty.");
  expect(emptyLine(["ready", "done"])).toBe("Ready and Done are empty.");
  expect(emptyLine([])).toBeUndefined();
});

test("Done shows its ten newest tickets, and Show older shows the rest", async () => {
  const done = Array.from({ length: 12 }, (_, n) => item({ ticket: String(n), title: `T${n}`, state: "done", updatedAt: `2026-11-01T10:${String(n).padStart(2, "0")}:00Z` }));
  vi.stubGlobal("fetch", vi.fn(async () => json(done)));
  renderWithQuery(<Board />);
  expect(await screen.findByText("T11")).toBeTruthy();
  expect(screen.queryByText("T1")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show 2 older" }));
  expect(screen.getByText("T1")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /older/ })).toBeNull();
});

// The segment colors of the progress line, one class per step.
const segments = (name: string) => [...screen.getByRole("img", { name }).children].map((c) => ["bg-foreground", "bg-data", "bg-destructive", "bg-raised"].find((k) => c.classList.contains(k)));

test("the progress line shows how far a run got: ink before, the data hue on a live step, red on a stuck or blocked one", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json([
    item({ ticket: "1", title: "Live", reached: "code-review", stepStartedAt: new Date().toISOString() }),
    item({ ticket: "2", title: "Ended", state: "blocked", reached: "triage" }),
    item({ ticket: "3", title: "Hung", reached: "verify", stuck: true }),
    item({ ticket: "4", title: "Paused", state: "needs_approval", reached: "decision" }),
  ])));
  renderWithQuery(<Board />);
  await screen.findByText("Live");
  const ink = (n: number) => Array(n).fill("bg-foreground");
  const off = (n: number) => Array(n).fill("bg-raised");
  expect(segments("Step 4 of 10, Code review")).toEqual([...ink(3), "bg-data", ...off(6)]);
  expect(segments("Step 2 of 10, Triage")).toEqual([...ink(1), "bg-destructive", ...off(8)]);
  expect(segments("Step 9 of 10, Verify")).toEqual([...ink(8), "bg-destructive", ...off(1)]);
  expect(segments("Step 7 of 10, Decision")).toEqual([...ink(7), ...off(3)]);
});

test("a live step shows its time against the stuck limit, red once over, and nothing without a limit", async () => {
  const ago = (m: number) => new Date(Date.now() - m * 60_000 - 1000).toISOString();
  vi.stubGlobal("fetch", vi.fn(async () => json([
    item({ ticket: "1", title: "Under", stepStartedAt: ago(12), stepLimit: 30 }),
    item({ ticket: "2", title: "Over", stepStartedAt: ago(45), stepLimit: 30 }),
    item({ ticket: "3", title: "No limit", stepStartedAt: ago(5) }),
  ])));
  renderWithQuery(<Board />);
  const under = await screen.findByText("12 of 30 m");
  const over = screen.getByText("45 of 30 m");
  expect(under.previousElementSibling!.firstElementChild!.className).toMatch(/bg-data/);
  expect(over.previousElementSibling!.firstElementChild!.className).toMatch(/bg-destructive/);
  expect(screen.queryAllByText(/ of \d+ m$/)).toHaveLength(2);
});

test("the search and target chips filter the cards, live in the URL, and leave the finding counting everything", async () => {
  window.history.replaceState(null, "", "/?target=api");
  const items = [item({ ticket: "12", title: "Fix login", state: "needs_approval" }), item({ ticket: "30", title: "Add docs", target: "api", state: "needs_approval" })];
  vi.stubGlobal("fetch", vi.fn(async () => json(items)));
  renderWithQuery(<Board />);
  expect(await screen.findByText("Add docs")).toBeTruthy();
  expect(screen.queryByText("Fix login")).toBeNull(); // the target from the URL
  expect(screen.getByRole("button", { name: "api", pressed: true })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "api" }));
  expect(window.location.search).toBe("");
  fireEvent.change(screen.getByRole("searchbox", { name: "Search work items" }), { target: { value: "#12" } });
  expect(window.location.search).toBe("?q=%2312");
  expect(screen.getByText("Fix login")).toBeTruthy();
  expect(screen.queryByText("Add docs")).toBeNull();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "nothing like it" } });
  expect(screen.getByText("No work item matches the filter.")).toBeTruthy();
  expect(finding(items)).toBe("2 to approve.");
});

test("one target shows no chips", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json([item({}), item({ ticket: "8" })])));
  renderWithQuery(<Board />);
  await screen.findByRole("searchbox");
  expect(screen.queryByRole("button", { name: "demo" })).toBeNull();
});

test("the tab title counts what waits for you, stuck runs too, and reads Factory at zero", async () => {
  let rows = [item({ state: "needs_info" }), item({ ticket: "8", stuck: true }), item({ ticket: "9", state: "done" })];
  vi.stubGlobal("fetch", vi.fn(async () => json(rows)));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Board /></QueryClientProvider>);
  await waitFor(() => expect(document.title).toBe("(2) Factory"));
  rows = [item({ state: "done" })];
  await client.refetchQueries();
  await waitFor(() => expect(document.title).toBe("Factory"));
});

test("/ focuses the search, but not while typing in a field", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json([item({})])));
  const { container } = renderWithQuery(<><textarea aria-label="note" /><Board /></>);
  const search = await screen.findByRole("searchbox");
  const note = within(container).getByRole("textbox", { name: "note" });
  note.focus();
  fireEvent.keyDown(note, { key: "/" });
  expect(document.activeElement).toBe(note);
  const editor = document.createElement("div");
  editor.contentEditable = "true";
  container.append(editor);
  editor.focus();
  fireEvent.keyDown(editor, { key: "/" });
  expect(document.activeElement).not.toBe(search);
  note.blur();
  fireEvent.keyDown(document.body, { key: "/" });
  expect(document.activeElement).toBe(search);
});

test("Notify me asks once, remembers the choice, and notifies when a work item starts to wait on you", async () => {
  const sent: string[] = [];
  const N = Object.assign(vi.fn(function (_: string, o: { body: string }) { sent.push(o.body); }), { permission: "default", requestPermission: vi.fn(async () => ((N.permission = "granted"), "granted")) });
  vi.stubGlobal("Notification", N);
  let rows = [item({ title: "Fix login" })];
  vi.stubGlobal("fetch", vi.fn(async () => json(rows)));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Board /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "Notify me" }));
  await screen.findByRole("button", { name: "Notifying" });
  expect(localStorage.getItem("board.notify")).toBe("on");
  rows = [item({ title: "Fix login", state: "needs_approval" })];
  await client.refetchQueries();
  await waitFor(() => expect(sent).toEqual(["Needs approval: Fix login"]));
  await client.refetchQueries(); // the same board again: nothing new
  expect(sent).toHaveLength(1);
});

test("no Notify me button when the browser has no notifications or the person refused them", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json([item({})])));
  vi.stubGlobal("Notification", { permission: "denied" });
  const { unmount } = renderWithQuery(<Board />);
  await screen.findByRole("searchbox");
  expect(screen.queryByRole("button", { name: "Notify me" })).toBeNull();
  unmount();
  vi.stubGlobal("Notification", undefined);
  renderWithQuery(<Board />);
  await screen.findByRole("searchbox");
  expect(screen.queryByRole("button", { name: "Notify me" })).toBeNull();
});

test("a notification goes out for a new wait for approval or info and a run that turned stuck, not for what already waited", () => {
  const prev = [item({ ticket: "1", state: "needs_info" }), item({ ticket: "2" }), item({ ticket: "3", stuck: true })];
  const next = [item({ ticket: "1", state: "needs_info" }), item({ ticket: "2", title: "Add docs", stuck: true }), item({ ticket: "3", stuck: true }), item({ ticket: "4", title: "New", state: "needs_approval" }), item({ ticket: "5", state: "blocked" })];
  expect(newlyWaiting(prev, next)).toEqual(["Stuck: Add docs", "Needs approval: New"]);
});
