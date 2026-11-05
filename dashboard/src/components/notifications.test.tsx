import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { BoardItem } from "./board";
import { Notifications } from "./notifications";
import { json, renderWithQuery, servePreferences } from "./test-utils";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const item = (o: Partial<BoardItem>): BoardItem => ({ target: "demo", ticket: "7", title: "Fix login", state: "running", url: "http://gl/7", updatedAt: "", stuck: false, ...o });
const end = (seq: number, outcome: string, ticket = "7") => ({ seq, id: `e${seq}`, run: `r${seq}`, at: "", target: "demo", ticket, type: "run_end", data: { outcome } });

// The bell asks three routes: the board, the run ends, and the user's preferences.
const serve = (board: () => unknown, ends: () => unknown = () => []) => {
  const prefs = servePreferences();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => (url === "/api/preferences" ? prefs.handle(init) : json(url === "/api/notifications" ? ends() : board()))));
  return prefs;
};

test("the bell counts what waits on a person and its panel links to each one", async () => {
  serve(() => [
    item({ ticket: "1", title: "Approve me", state: "needs_approval", run: "r1" }),
    item({ ticket: "2", title: "Stuck run", stuck: true, run: "r2" }),
    item({ ticket: "3", title: "Just running" }),
  ]);
  renderWithQuery(<Notifications />);
  fireEvent.click(await screen.findByRole("button", { name: "Notifications, 2 new" }));
  expect(screen.getByRole("link", { name: /Approve me/ }).getAttribute("href")).toBe("/runs/r1");
  expect(screen.getByRole("link", { name: /Stuck run/ }).getAttribute("href")).toBe("/runs/r2");
  expect(screen.queryByText("Just running")).toBeNull();
});

test("run ends count as unread until the panel opens, and stay read after a reload", async () => {
  serve(() => [item({ title: "Fix login" })], () => [end(5, "done"), end(3, "blocked", "9")]);
  const first = renderWithQuery(<Notifications />);
  fireEvent.click(await screen.findByRole("button", { name: "Notifications, 2 new" }));
  expect(screen.getByRole("link", { name: /Fix login/ }).getAttribute("href")).toBe("/runs/r5"); // the board's title for demo #7
  expect(screen.getByRole("link", { name: /demo #9/ }).textContent).toContain("Blocked");
  expect(screen.getAllByLabelText("Unread")).toHaveLength(2);
  first.unmount();
  renderWithQuery(<Notifications />);
  fireEvent.click(await screen.findByRole("button", { name: "Notifications" }));
  await screen.findByRole("link", { name: /Fix login/ }); // the run ends loaded, and none counts as new
  expect(screen.queryAllByLabelText("Unread")).toHaveLength(0);
  expect(screen.getByRole("button", { name: "Notifications" })).toBeTruthy();
});

test("Notify me asks once, remembers the choice, and notifies when a work item starts to wait on you", async () => {
  const sent: string[] = [];
  const N = Object.assign(vi.fn(function (_: string, o: { body: string }) { sent.push(o.body); }), { permission: "default", requestPermission: vi.fn(async () => ((N.permission = "granted"), "granted")) });
  vi.stubGlobal("Notification", N);
  let rows = [item({ title: "Fix login" })];
  const { puts } = serve(() => rows);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Notifications /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "Notifications" }));
  fireEvent.click(await screen.findByRole("button", { name: "Notify me" }));
  await screen.findByRole("button", { name: "Notifying" });
  await waitFor(() => expect(puts).toEqual([{ notify: true }]));
  rows = [item({ title: "Fix login", state: "needs_approval" })];
  await client.refetchQueries();
  await waitFor(() => expect(sent).toEqual(["Needs approval: Fix login"]));
  await client.refetchQueries(); // the same board again: nothing new
  expect(sent).toHaveLength(1);
});

test("no Notify me button when the browser has no notifications or the person refused them", async () => {
  serve(() => [item({})]);
  vi.stubGlobal("Notification", { permission: "denied" });
  const { unmount } = renderWithQuery(<Notifications />);
  fireEvent.click(await screen.findByRole("button", { name: "Notifications" }));
  expect(screen.queryByRole("button", { name: "Notify me" })).toBeNull();
  unmount();
  vi.stubGlobal("Notification", undefined);
  renderWithQuery(<Notifications />);
  fireEvent.click(await screen.findByRole("button", { name: "Notifications" }));
  expect(screen.queryByRole("button", { name: "Notify me" })).toBeNull();
});
