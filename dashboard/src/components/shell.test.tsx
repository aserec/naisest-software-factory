import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ThemeSync, UserMenu } from "./shell";
import { renderWithQuery, servePreferences } from "./test-utils";

afterEach(() => {
  cleanup();
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
