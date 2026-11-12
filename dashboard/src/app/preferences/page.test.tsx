import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { renderWithQuery, servePreferences } from "@/components/test-utils";
import PreferencesPage from "./page";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("shows the saved preferences and saves a change", async () => {
  const p = servePreferences({ theme: "dark", insightsRange: "24h" });
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => p.handle(init)));
  vi.stubGlobal("Notification", { permission: "denied" });
  renderWithQuery(<PreferencesPage />);
  await screen.findByText(/Signed in as ann/);
  expect((screen.getByLabelText("Theme") as HTMLSelectElement).value).toBe("dark");
  expect((screen.getByLabelText("Default range") as HTMLSelectElement).value).toBe("24h");
  expect(screen.getByText(/blocks notifications/)).toBeTruthy();
  expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Default range"), { target: { value: "30d" } });
  await waitFor(() => expect(p.puts).toEqual([{ insightsRange: "30d" }]));
  fireEvent.change(screen.getByLabelText("Language"), { target: { value: "es" } });
  await screen.findByLabelText("Tema");
  await waitFor(() => expect(p.puts.at(-1)).toEqual({ language: "es" }));
});
