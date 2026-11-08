import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { RunTarget, Shell, ThemeSync, UserMenu } from "./shell";
import { renderWithQuery, servePreferences } from "./test-utils";

const nav = vi.hoisted(() => ({ path: "/boards/api" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.path }));
// happy-dom cancels motion's animations with an unhandled rejection; plain elements are enough here.
vi.mock("motion/react", () => ({
  motion: {
    span: ({ layoutId: _, ...p }: React.HTMLAttributes<HTMLSpanElement> & { layoutId?: string }) => <span {...p} />,
    div: ({ initial: _i, animate: _a, ...p }: React.HTMLAttributes<HTMLDivElement> & { initial?: unknown; animate?: unknown }) => <div {...p} />,
  },
}));

afterEach(() => {
  cleanup();
  nav.path = "/boards/api";
  vi.unstubAllGlobals();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

const serve = (prefs: Record<string, unknown> = {}) => {
  const p = servePreferences(prefs);
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => p.handle(init)));
  return p;
};

test("the saved theme lands on <html> and in localStorage for the next first paint", async () => {
  serve({ theme: "dark" });
  renderWithQuery(<ThemeSync />);
  await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("dark"));
  expect(localStorage.getItem("theme")).toBe("dark");
});

test("the account menu names the user and holds Preferences and Sign out", async () => {
  serve();
  const signOut = vi.fn(async () => {});
  renderWithQuery(<UserMenu signOut={signOut} />);
  const trigger = await screen.findByRole("button", { name: /ann/ });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
  expect(await screen.findByText("Signed in with Forge")).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Preferences" }).getAttribute("href")).toBe("/preferences");
  fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
  await waitFor(() => expect(signOut).toHaveBeenCalledOnce());
});

test("the nav holds Board with one child board per target and marks only the open one", async () => {
  serve();
  renderWithQuery(<Shell signOut={async () => {}} boards={["api", "api2"]}>x</Shell>);
  const nav = (await screen.findAllByRole("navigation", { name: "Main" }))[0];
  const board = within(nav).getByRole("link", { name: "Board" });
  expect(board.getAttribute("href")).toBe("/");
  expect(board.getAttribute("aria-current")).toBeNull();
  const children = within(within(nav).getByRole("list")).getAllByRole("link");
  expect(children.map((l) => l.getAttribute("href"))).toEqual(["/boards/api", "/boards/api2"]);
  expect(children.map((l) => l.getAttribute("aria-current"))).toEqual(["page", null]);
});

test("each target's board shows how many runs wait on you", async () => {
  const p = servePreferences();
  const item = (target: string, state: string) => ({ target, state, ticket: 1, title: "t" });
  const board = [item("api", "needs_approval"), item("api", "needs_info"), item("api", "running"), item("api2", "running")];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => (String(url).includes("/api/board") ? Response.json(board) : String(url).includes("/api/notifications") ? Response.json([]) : p.handle(init))));
  renderWithQuery(<Shell signOut={async () => {}} boards={["api", "api2"]}>x</Shell>);
  const nav = (await screen.findAllByRole("navigation", { name: "Main" }))[0];
  await waitFor(() => expect(within(nav).getByRole("link", { name: /api$/ }).textContent).toBe("2 waiting on youapi"));
  expect(within(nav).getByRole("link", { name: /api2/ }).textContent).toBe("0 waiting on youapi2");
});

test("a run's breadcrumb goes Board, then its target's board, then the run", async () => {
  serve();
  nav.path = "/runs/0123456789abcdef";
  renderWithQuery(
    <Shell signOut={async () => {}} boards={["api"]}>
      <RunTarget target="api" />
    </Shell>,
  );
  const trail = screen.getByRole("list", { name: "Breadcrumb" });
  await waitFor(() => expect(trail.textContent).toBe("Board/api/Run 01234567"));
  const target = within(trail).getByRole("link", { name: "api" });
  expect(target.getAttribute("href")).toBe("/boards/api");
});
