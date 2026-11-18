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
    expect(f).toHaveBeenCalledWith("/api/settings", expect.objectContaining({ method: "PUT", body: JSON.stringify({ target: "api", thresholds: { diffRiskMax: 6, clarityMin: 8, autoMergeTriageMax: "trivial" }, factoryFile: FILE, language: "", models: {} }) })),
  );
  fireEvent.mouseDown(screen.getByRole("tab", { name: "web" }));
  const web = screen.getByRole("tabpanel", { name: "web" });
  expect((within(web).getByLabelText("Lowest clarity to build") as HTMLInputElement).value).toBe("6");
});

test("a target picks the author's model and effort, and the reviewer left empty follows router.yml", async () => {
  const modelOptions = { author: { model: "opus", effort: "medium", models: { opus: "opus", sonnet: "sonnet" } }, reviewer: { model: "opus", effort: "xhigh", models: { opus: "opus", sonnet: "sonnet" } } };
  const f = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === "PUT" ? new Response(null, { status: 204 }) : json({ api: { thresholds: {}, modelOptions } })));
  vi.stubGlobal("fetch", f);
  renderWithQuery(<SettingsPage />);
  const api = await screen.findByRole("tabpanel", { name: "api" });
  expect(within(api).getByLabelText("Reviewer model").textContent).toContain("From router.yml (opus, xhigh)");
  fireEvent.change(within(api).getByLabelText("Author model"), { target: { value: "sonnet" } });
  fireEvent.change(within(api).getByLabelText("Author model effort"), { target: { value: "high" } });
  fireEvent.click(within(api).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(f).toHaveBeenCalledWith("/api/settings", expect.objectContaining({ method: "PUT", body: expect.stringContaining('"models":{"author":{"model":"sonnet","effort":"high"}}') })));
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

test("the auto-merge toggle changes the target's auto_merge switch only on Save, in the same request as the limits", async () => {
  const sw = { "*": { auto_merge: true }, api: { auto_merge: true } };
  const f = vi.fn(async (url: string, init?: RequestInit) => (init?.method === "PUT" ? new Response(null, { status: 204 }) : url === "/api/switches" ? json(sw) : json({ api: { thresholds: {} } })));
  vi.stubGlobal("fetch", f);
  renderWithQuery(<SettingsPage />);
  const api = await screen.findByRole("tabpanel", { name: "api" });
  const toggle = within(api).getByRole("switch", { name: "Auto-merge" });
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  fireEvent.click(toggle);
  expect(f).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ method: "PUT" }));
  fireEvent.click(within(api).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(f).toHaveBeenCalledWith("/api/settings", expect.objectContaining({ method: "PUT", body: expect.stringContaining('"autoMerge":false') })));
  expect(f).not.toHaveBeenCalledWith("/api/switches", expect.objectContaining({ method: "PUT" }));
});

test("Save leaves the auto_merge switch alone when the toggle did not change", async () => {
  const f = vi.fn(async (url: string, init?: RequestInit) => (init?.method === "PUT" ? new Response(null, { status: 204 }) : url === "/api/switches" ? json({ "*": { auto_merge: true }, api: { auto_merge: true } }) : json({ api: { thresholds: {} } })));
  vi.stubGlobal("fetch", f);
  renderWithQuery(<SettingsPage />);
  const api = await screen.findByRole("tabpanel", { name: "api" });
  await waitFor(() => expect(within(api).getByRole("switch", { name: "Auto-merge" }).getAttribute("aria-checked")).toBe("true"));
  fireEvent.click(within(api).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(f).toHaveBeenCalledWith("/api/settings", expect.objectContaining({ method: "PUT" })));
  expect(f).not.toHaveBeenCalledWith("/api/settings", expect.objectContaining({ body: expect.stringContaining("autoMerge") }));
});

test("the auto-merge toggle is locked when the all-targets switch is off", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => (url === "/api/switches" ? json({ "*": { auto_merge: false }, api: { auto_merge: false } }) : json({ api: { thresholds: {} } }))));
  renderWithQuery(<SettingsPage />);
  const api = await screen.findByRole("tabpanel", { name: "api" });
  expect(await within(api).findByText("Off for all targets on the Switches page.")).toBeTruthy();
  expect(within(api).getByRole("switch", { name: "Auto-merge" }).hasAttribute("disabled")).toBe(true);
});
