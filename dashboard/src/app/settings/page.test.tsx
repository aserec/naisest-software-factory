import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery } from "@/components/test-utils";
import SettingsPage from "./page";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const FILE = "install: i\nlint: l\ntest: t\nbuild: b";

test("shows each target's saved values, and saves only what differs from the defaults with the commands", async () => {
  const f = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === "PUT" ? new Response(null, { status: 204 }) : json({ api: { thresholds: { clarityMin: 8 }, factoryFile: FILE, user: "ann", at: new Date().toISOString() }, web: { thresholds: {} } }),
  );
  vi.stubGlobal("fetch", f);
  renderWithQuery(<SettingsPage />);
  const api = await screen.findByRole("tabpanel", { name: "api" });
  expect((within(api).getByLabelText("Lowest clarity to build") as HTMLInputElement).value).toBe("8");
  expect((within(api).getByLabelText(".factory.yml commands") as HTMLTextAreaElement).value).toBe(FILE);
  expect(within(api).getByText(/Saved by ann/)).toBeTruthy();
  fireEvent.change(within(api).getByLabelText("Highest merge risk that merges alone"), { target: { value: "6" } });
  fireEvent.change(within(api).getByLabelText("Highest triage risk that merges alone"), { target: { value: "trivial" } });
  fireEvent.click(within(api).getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(f).toHaveBeenCalledWith("/api/settings", expect.objectContaining({ method: "PUT", body: JSON.stringify({ target: "api", thresholds: { diffRiskMax: 6, clarityMin: 8, autoMergeTriageMax: "trivial" }, factoryFile: FILE }) })),
  );
  fireEvent.mouseDown(screen.getByRole("tab", { name: "web" }));
  const web = screen.getByRole("tabpanel", { name: "web" });
  expect((within(web).getByLabelText("Lowest clarity to build") as HTMLInputElement).value).toBe("6");
});

test("a refused save shows the server's reason", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => (init?.method === "PUT" ? new Response("The .factory.yml commands are not valid: build is required", { status: 400 }) : json({ api: { thresholds: {} } }))));
  renderWithQuery(<SettingsPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Save" }));
  expect((await screen.findByRole("alert")).textContent).toContain("build is required");
});

test("the Factory tab lists the rules every target must meet to merge alone", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ api: { thresholds: {} } })));
  renderWithQuery(<SettingsPage />);
  fireEvent.mouseDown(await screen.findByRole("tab", { name: "Factory" }));
  expect(screen.getByRole("tabpanel", { name: "Factory" }).textContent).toContain("Every hard rule passes");
});
