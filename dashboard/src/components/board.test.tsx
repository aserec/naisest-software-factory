import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ago, duration } from "@/lib/utils";
import { Board, ConflictsBadge, newlyWaiting, RiskPills, type BoardItem } from "./board";
import { json, renderWithQuery } from "./test-utils";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
  localStorage.clear();
});

const item = (o: Partial<BoardItem>): BoardItem => ({ target: "demo", ticket: "7", title: "Fix login", state: "running", url: "http://gl/7", updatedAt: "", stuck: false, ...o });

test("renders a section per label, empty ones with 0, and a Stuck badge", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json([item({ run: "r1", costUsd: 1.5, stuck: true }), item({ ticket: "8", title: "Add docs", state: "done" })])));
  renderWithQuery(<Board />);
  expect(await screen.findByText("Fix login")).toBeTruthy();
  expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Waiting on you", "With the factory"]);
  expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Needs approval 0", "Needs info 0", "Stopped 0", "Blocked 0", "Running 1", "Waiting 0", "Ready 0"]);
  expect(screen.queryByText(/are empty/)).toBeNull();
  expect(screen.getAllByText("Stuck")).toHaveLength(1);
  expect(screen.getByText("$1.50")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Fix login" }).getAttribute("href")).toBe("/runs/r1");
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Finished 1" }));
  expect(screen.getByRole("link", { name: "Add docs" }).getAttribute("href")).toBe("http://gl/7"); // no run: links to GitLab
});

test("Finished holds done work items and the ones closed before done; they leave Ongoing and wait for no one", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json([
    item({}),
    item({ ticket: "8", title: "Shipped", state: "done", closed: true }),
    item({ ticket: "9", title: "Dropped", state: "needs_approval", closed: true, stuck: true }),
  ])));
  renderWithQuery(<Board />);
  await screen.findByText("Fix login");
  expect(screen.getByRole("tab", { name: "Ongoing 1" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Needs approval 0" })).toBeTruthy();
  expect(screen.queryByText("Dropped")).toBeNull();
  expect(document.title).toBe("Factory");
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Finished 2" }));
  expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Done 1", "Closed 1"]);
  expect(within(screen.getByRole("heading", { name: "Closed 1" }).closest("section")!).getByText("Dropped")).toBeTruthy();
  expect(window.location.search).toBe("?tab=finished");
  expect(screen.queryByText("Fix login")).toBeNull();
});

test("PR problems splits work items into waiting, being resolved and resolved, and keeps a resolved one a day after it finishes", async () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
  vi.stubGlobal("fetch", vi.fn(async () => json([
    item({ title: "Resolving", conflicts: true, step: "prepare-patch", stepStartedAt: hoursAgo(0) }),
    item({ ticket: "8", title: "Paused", state: "needs_approval", conflicts: true, step: "decision", resolvedCount: 2, resolvedAt: "2026-11-06T21:29:00Z" }),
    item({ ticket: "9", title: "Clean", state: "needs_approval" }),
    item({ ticket: "10", title: "Shipped", state: "done", conflicts: true }),
    item({ ticket: "11", title: "Cleared", state: "needs_approval", conflicts: false, resolvedCount: 1, resolvedAt: hoursAgo(2) }),
    item({ ticket: "12", title: "Red build", state: "needs_approval", checksFailed: true }),
    item({ ticket: "13", title: "Merged today", state: "done", stateSince: hoursAgo(3), resolvedCount: 1, resolvedAt: hoursAgo(5) }),
    item({ ticket: "14", title: "Merged last week", state: "done", stateSince: hoursAgo(30), resolvedCount: 1, resolvedAt: hoursAgo(40) }),
  ])));
  renderWithQuery(<Board />);
  await screen.findByText("Clean");
  fireEvent.mouseDown(screen.getByRole("tab", { name: "PR problems 5" }));
  expect(window.location.search).toBe("?tab=problems");
  const column = (name: string) => within(screen.getByRole("heading", { name }).closest("section")!);
  expect(column("Waiting 2").getByText("Paused")).toBeTruthy();
  expect(column("Waiting 2").getByText("Red build")).toBeTruthy();
  expect(column("Waiting 2").getByText(/^Resolved 2 times, last /)).toBeTruthy();
  expect(column("Being resolved 1").getByText("Resolving")).toBeTruthy();
  expect(column("Resolved 2").getByText("Cleared")).toBeTruthy();
  expect(column("Resolved 2").getByText("Merged today")).toBeTruthy();
  expect(column("Resolved 2").getAllByText(/^Resolved once, last /)).toHaveLength(2);
  for (const t of ["Clean", "Shipped", "Merged last week"]) expect(screen.queryByText(t)).toBeNull();
});

test("a PR that cannot merge takes the red button with the reason; a done one never; a card with no run shows no cost", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json([
    item({ title: "Conflicted", state: "needs_approval", conflicts: true, changeUrl: "http://gl/pr/1" }),
    item({ ticket: "8", title: "Clean", state: "needs_approval", changeUrl: "http://gl/pr/2" }),
    item({ ticket: "9", title: "Queued", state: "ready" }),
    item({ ticket: "10", title: "Behind", state: "running", mergeBlock: "it is behind the base branch", changeUrl: "http://gl/pr/3" }),
    item({ ticket: "11", title: "Merged", state: "done", conflicts: true, changeUrl: "http://gl/pr/4" }),
  ])));
  renderWithQuery(<Board />);
  await screen.findByText("Clean");
  expect(screen.getByRole("link", { name: "Open PR, it cannot merge: it has conflicts with the base branch" }).getAttribute("href")).toBe("http://gl/pr/1");
  expect(screen.getByRole("link", { name: "Open PR, it cannot merge: it is behind the base branch" }).getAttribute("href")).toBe("http://gl/pr/3");
  expect(screen.getAllByRole("link", { name: "Open PR" }).map((a) => a.getAttribute("href"))).toEqual(["http://gl/pr/2"]);
  expect(screen.queryByText("—")).toBeNull();
});

test("a card shows the live step, the round and both risks", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json([item({ run: "r1", step: "code-review", round: 2, risk: "low", mergeRisk: 3 })])));
  renderWithQuery(<Board />);
  expect(await screen.findByText(/Code review · round 2/)).toBeTruthy();
  expect(screen.getByText("Triage risk low")).toBeTruthy();
  expect(screen.getByText("Merge risk 3/10, limit 4")).toBeTruthy();
});

test("a card says since when the factory set its state, and nothing without that time", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json([item({ state: "needs_approval", stateSince: "2026-10-29T10:05:00Z" }), item({ ticket: "8", title: "Add docs" })])));
  renderWithQuery(<Board />);
  await screen.findByText("Add docs");
  const since = screen.getByText(/^Needs approval since /);
  expect(since.getAttribute("datetime")).toBe("2026-10-29T10:05:00Z");
  expect(screen.getAllByText(/ since /)).toHaveLength(1);
});

test("a card whose change has conflicts with the base branch shows Conflicts; one without shows none", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json([item({ run: "r1", state: "needs_approval", conflicts: true }), item({ ticket: "8", title: "Add docs", run: "r2", conflicts: false })])));
  renderWithQuery(<Board />);
  await screen.findByText("Add docs");
  expect(screen.getAllByText("Conflicts")).toHaveLength(1);
  expect(within(screen.getByRole("link", { name: "Fix login" }).closest("li")!).getByText("Conflicts")).toBeTruthy();
});

test("a ready card that waits for open work items shows which ones; a free one and a card in another state show none", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json([
    item({ state: "ready", blockedBy: ["http://gl/2", "http://gl/3"] }),
    item({ ticket: "8", title: "Add docs", state: "ready", blockedBy: [] }),
    item({ ticket: "9", title: "Old", state: "running", blockedBy: ["http://gl/4"] }),
  ])));
  renderWithQuery(<Board />);
  await screen.findByText("Add docs");
  expect(screen.getAllByText(/^Waits for/).map((b) => [b.closest("li")!.querySelector("a")!.textContent, b.textContent, b.getAttribute("title")])).toEqual([
    ["Fix login", "Waits for #2, #3", "Waits until #2, #3 are closed. The factory starts this work item after that."],
  ]);
});
test("the run page's conflicts badge shows only for a change with conflicts", () => {
  const { rerender } = render(<ConflictsBadge conflicts />);
  expect(screen.getByText("Conflicts").getAttribute("title")).toMatch(/conflicts with the base branch/);
  rerender(<ConflictsBadge conflicts={false} />);
  expect(screen.queryByText("Conflicts")).toBeNull();
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

test("every state keeps its section, an empty one with 0", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json([])));
  renderWithQuery(<Board />);
  for (const name of ["Needs approval", "Waiting", "Ready"]) expect((await screen.findByRole("heading", { name: `${name} 0` })).tagName).toBe("H3");
});

test("durations and ages read as people say them", () => {
  expect([0.25, 42, 540, 545, 8400].map(duration)).toEqual(["250 ms", "42 s", "9 m", "9 m 5 s", "2 h 20 m"]);
  const now = Date.parse("2026-11-01T12:00:00Z");
  expect([ago("2026-11-01T11:59:40Z", now), ago("2026-11-01T11:12:00Z", now), ago("2026-10-30T12:00:00Z", now), ago("", now)]).toEqual(["just now", "48 m ago", "2 d ago", undefined]);
});

test("Done shows its ten newest tickets, and Show older shows the rest", async () => {
  const done = Array.from({ length: 12 }, (_, n) => item({ ticket: String(n), title: `T${n}`, state: "done", updatedAt: `2026-11-01T10:${String(n).padStart(2, "0")}:00Z` }));
  vi.stubGlobal("fetch", vi.fn(async () => json(done)));
  window.history.replaceState(null, "", "/?tab=finished");
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

test("a notification goes out for a new wait for approval or info and a run that turned stuck, not for what already waited", () => {
  const prev = [item({ ticket: "1", state: "needs_info" }), item({ ticket: "2" }), item({ ticket: "3", stuck: true })];
  const next = [item({ ticket: "1", state: "needs_info" }), item({ ticket: "2", title: "Add docs", stuck: true }), item({ ticket: "3", stuck: true }), item({ ticket: "4", title: "New", state: "needs_approval" }), item({ ticket: "5", state: "blocked" })];
  expect(newlyWaiting(prev, next)).toEqual(["Stuck: Add docs", "Needs approval: New"]);
});

test("Refresh asks the server for a fresh board", async () => {
  const f = vi.fn(async (_url: string) => json([item({})]));
  vi.stubGlobal("fetch", f);
  renderWithQuery(<Board />);
  await screen.findByText("Fix login");
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(f.mock.calls.map((c) => c[0])).toContain("/api/board?fresh=1"));
});

test("every card links its issue, and its PR as soon as one exists, also mid-run", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json([
    item({ run: "r1", state: "needs_approval", changeUrl: "http://gl/mr/1" }),
    item({ ticket: "8", title: "Add docs", run: "r2", state: "running", changeUrl: "http://gl/mr/2", url: "http://gl/8" }),
  ])));
  renderWithQuery(<Board />);
  await screen.findByText("Add docs");
  const card = (name: string) => within(screen.getByRole("link", { name }).closest("li")!);
  expect(card("Fix login").getByRole("link", { name: "Open PR" }).getAttribute("href")).toBe("http://gl/mr/1");
  expect(card("Fix login").getByRole("link", { name: "Open issue" }).getAttribute("href")).toBe("http://gl/7");
  expect(card("Add docs").getByRole("link", { name: "Open PR" }).getAttribute("href")).toBe("http://gl/mr/2");
  expect(card("Add docs").getByRole("link", { name: "Open issue" }).getAttribute("href")).toBe("http://gl/8");
});
