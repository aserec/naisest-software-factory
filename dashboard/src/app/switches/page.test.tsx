import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery } from "@/components/test-utils";
import SwitchesPage from "./page";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const all = { watcher: true, dispatches: true, new_runs: true, retry: true, questions: true, prepare_patch: true, auto_merge: true, apply: true };

test("shows a switch per scope and sends the new value when one is flipped", async () => {
  const f = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === "PUT" ? new Response(null, { status: 204 }) : json({ "*": all, demo: { ...all, apply: false } })));
  vi.stubGlobal("fetch", f);
  renderWithQuery(<SwitchesPage />);
  const apply = await screen.findByRole("switch", { name: "apply for demo" });
  expect(apply.getAttribute("aria-checked")).toBe("false");
  expect(screen.getByText("All targets")).toBeTruthy();
  fireEvent.click(apply);
  await waitFor(() => expect(f).toHaveBeenCalledWith("/api/switches", expect.objectContaining({ method: "PUT", body: JSON.stringify({ scope: "demo", name: "apply", on: true }) })));
});

test("shows the reason when the change is refused", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => (init?.method === "PUT" ? new Response("no role", { status: 403 }) : json({ "*": all }))));
  renderWithQuery(<SwitchesPage />);
  fireEvent.click(await screen.findByRole("switch", { name: "retry for *" }));
  expect((await screen.findByRole("alert")).textContent).toBe("no role");
});
