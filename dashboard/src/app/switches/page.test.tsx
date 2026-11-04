import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery } from "@/components/test-utils";
import SwitchesPage from "./page";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const all = { watcher: true, dispatches: true, new_runs: true, retry: true, questions: true, prepare_patch: true, auto_merge: true, apply: true };

const put = (f: ReturnType<typeof vi.fn>) => f.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT");

test("shows a switch per scope and sends the new value when one is flipped", async () => {
  const f = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === "PUT" ? new Response(null, { status: 204 }) : json({ "*": all, demo: { ...all, retry: false } })));
  vi.stubGlobal("fetch", f);
  renderWithQuery(<SwitchesPage />);
  const retry = await screen.findByRole("switch", { name: "Retry for demo" });
  expect(retry.getAttribute("aria-checked")).toBe("false");
  expect(screen.getByText("All targets")).toBeTruthy();
  fireEvent.click(retry);
  await waitFor(() => expect(f).toHaveBeenCalledWith("/api/switches", expect.objectContaining({ method: "PUT", body: JSON.stringify({ scope: "demo", name: "retry", on: true }) })));
});

test("turning on Apply asks first and sends nothing until confirmed; turning it off does not ask", async () => {
  const f = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === "PUT" ? new Response(null, { status: 204 }) : json({ "*": all, demo: { ...all, apply: false } })));
  vi.stubGlobal("fetch", f);
  renderWithQuery(<SwitchesPage />);
  const apply = await screen.findByRole("switch", { name: "Apply for demo" });
  expect(apply.getAttribute("data-state")).toBe("unchecked"); // the track color hangs on it
  apply.focus();
  fireEvent.click(apply);
  expect((await screen.findByRole("alertdialog")).textContent).toContain("Turn on Apply for demo?");
  expect(put(f)).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(document.activeElement).toBe(apply)); // focus goes back to the switch
  expect(put(f)).toHaveLength(0);
  fireEvent.click(apply);
  await screen.findByRole("alertdialog");
  fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
  await waitFor(() => expect(put(f).map(([, i]) => (i as RequestInit).body)).toEqual([JSON.stringify({ scope: "demo", name: "apply", on: true })]));
  fireEvent.click(screen.getByRole("switch", { name: "Apply for all targets" }));
  await waitFor(() => expect(put(f)).toHaveLength(2));
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

test("a target whose switch the all-targets row turns off says so instead of showing a switch", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ "*": { ...all, auto_merge: false }, demo: { ...all, auto_merge: false } })));
  renderWithQuery(<SwitchesPage />);
  expect(await screen.findByText("Off (all targets)")).toBeTruthy();
  expect(screen.queryByRole("switch", { name: "Auto merge for demo" })).toBeNull();
  expect(screen.getByRole("switch", { name: "Auto merge for all targets" })).toBeTruthy();
});

test("while a change is sent, only that switch is disabled", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => (init?.method === "PUT" ? new Promise<Response>(() => {}) : json({ "*": all }))));
  renderWithQuery(<SwitchesPage />);
  const retry = await screen.findByRole("switch", { name: "Retry for all targets" });
  fireEvent.click(retry);
  await waitFor(() => expect(retry.hasAttribute("disabled")).toBe(true));
  expect(screen.getByRole("switch", { name: "Watcher for all targets" }).hasAttribute("disabled")).toBe(false);
});

test("shows the reason when the change is refused", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => (init?.method === "PUT" ? new Response("no role", { status: 403 }) : json({ "*": all }))));
  renderWithQuery(<SwitchesPage />);
  fireEvent.click(await screen.findByRole("switch", { name: "Retry for all targets" }));
  expect((await screen.findByRole("alert")).textContent).toBe("no role");
});
