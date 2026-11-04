import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ago, duration } from "@/lib/utils";
import { Board, emptyLine, finding, RiskPills, type BoardItem } from "./board";
import { json, renderWithQuery } from "./test-utils";

afterEach(() => vi.unstubAllGlobals());

const item = (o: Partial<BoardItem>): BoardItem => ({ target: "demo", ticket: "7", title: "Fix login", state: "factory_running", url: "http://gl/7", updatedAt: "", stuck: false, ...o });

test("renders a section per label that has tickets, one line for the empty ones, and a Stuck badge", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json([item({ run: "r1", costUsd: 1.5, stuck: true }), item({ ticket: "8", title: "Add docs", state: "factory_done" })])));
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
  expect(await screen.findByText(/code-review · round 2/)).toBeTruthy();
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
  expect(finding([item({ state: "factory_needs_approval" }), item({ state: "factory_needs_info" }), item({ state: "factory_needs_info" }), item({ stuck: true })])).toBe("1 to approve, 2 need an answer, 1 run stuck.");
  expect(finding([item({ state: "factory_done" })])).toBe("Nothing waits for you.");
});

test("durations and ages read as people say them", () => {
  expect([duration(42), duration(540), duration(8400)]).toEqual(["42 s", "9 m", "2 h 20 m"]);
  const now = Date.parse("2026-11-01T12:00:00Z");
  expect([ago("2026-11-01T11:59:40Z", now), ago("2026-11-01T11:12:00Z", now), ago("2026-10-30T12:00:00Z", now), ago("", now)]).toEqual(["just now", "48 m ago", "2 d ago", undefined]);
});

test("the empty line names one or many labels, and nothing when none is empty", () => {
  expect(emptyLine(["factory_done"])).toBe("Done is empty.");
  expect(emptyLine(["factory_ready", "factory_done"])).toBe("Ready and Done are empty.");
  expect(emptyLine([])).toBeUndefined();
});

test("Done shows its ten newest tickets and counts the rest", async () => {
  const done = Array.from({ length: 12 }, (_, n) => item({ ticket: String(n), title: `T${n}`, state: "factory_done", updatedAt: `2026-11-01T10:${String(n).padStart(2, "0")}:00Z` }));
  vi.stubGlobal("fetch", vi.fn(async () => json(done)));
  renderWithQuery(<Board />);
  expect(await screen.findByText("T11")).toBeTruthy();
  expect(screen.queryByText("T1")).toBeNull();
  expect(screen.getByText("And 2 older.")).toBeTruthy();
});
