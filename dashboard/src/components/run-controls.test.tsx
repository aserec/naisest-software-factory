import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { RunControls } from "./run-controls";
import { json, renderWithQuery } from "./test-utils";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const state = (o: object) => ({ cancelled: false, restarted: false, pending: [], ...o });
const names = () => screen.queryAllByRole("button").map((b) => b.textContent);

// A fake server: GET state returns `s`, a POST answers `post`.
function server(s: object, post = new Response("{}")) {
  const f = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === "POST" ? post : json(state(s))));
  vi.stubGlobal("fetch", f);
  return f;
}

test("Stop asks first, then posts the stop for the run", async () => {
  const f = server({ label: "factory_running" });
  renderWithQuery(<RunControls run="r 1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
  expect(f.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false); // the dialog only asks
  fireEvent.click(screen.getAllByRole("button", { name: "Stop" }).at(-1)!); // the one in the dialog
  await waitFor(() => expect(f).toHaveBeenCalledWith("/api/runs/r%201/stop", { method: "POST" }));
});

test("Cancel closes the confirm, starts with focus, and posts nothing", async () => {
  const f = server({ label: "factory_running" });
  renderWithQuery(<RunControls run="r1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
  const cancel = await screen.findByRole("button", { name: "Cancel" });
  await waitFor(() => expect(document.activeElement).toBe(cancel));
  fireEvent.click(cancel);
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(f.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
});

test("a stopped run shows Resume and Restart, and no Stop", async () => {
  server({ label: "factory_stopped" });
  renderWithQuery(<RunControls run="r1" />);
  await screen.findByRole("button", { name: "Resume" });
  expect(names()).toEqual(["Resume", "Restart"]);
});

test("Resume is hidden when a pipeline cancel ended the run", async () => {
  server({ label: "factory_stopped", cancelled: true });
  renderWithQuery(<RunControls run="r1" />);
  await screen.findByRole("button", { name: "Restart" });
  expect(names()).toEqual(["Restart"]);
});

test("after a pipeline cancel only Restart shows, even before the label says stopped", async () => {
  server({ label: "factory_running", cancelled: true });
  renderWithQuery(<RunControls run="r1" />);
  await screen.findByRole("button", { name: "Restart" });
  expect(names()).toEqual(["Restart"]);
});

test("a run in any other state has no buttons, and a waiting request replaces them", async () => {
  server({ label: "factory_done" });
  renderWithQuery(<RunControls run="r1" />);
  await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
  expect(names()).toEqual([]);
  cleanup();
  server({ label: "factory_running", pending: ["stop"] });
  renderWithQuery(<RunControls run="r1" />);
  expect((await screen.findByText(/Stop requested/)).textContent).toBeTruthy();
  expect(names()).toEqual([]);
});

test("a run with a done restart has no buttons, even after a pipeline cancel", async () => {
  server({ label: "factory_stopped", cancelled: true, restarted: true });
  const { container } = renderWithQuery(<RunControls run="r1" />);
  await waitFor(() => expect(container.firstChild).not.toBeNull()); // the state arrived
  expect(names()).toEqual([]);
});

test("shows the reason when the server refuses", async () => {
  server({ label: "factory_running" }, new Response("already requested", { status: 409 }));
  renderWithQuery(<RunControls run="r1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
  fireEvent.click(screen.getAllByRole("button", { name: "Stop" }).at(-1)!);
  expect((await screen.findByRole("alert")).textContent).toBe("already requested");
});

test("says why there are no buttons, and that the state could not be read", async () => {
  server({ label: "factory_done" });
  renderWithQuery(<RunControls run="r1" />);
  expect((await screen.findByText(/factory_done/)).closest("p")?.textContent).toBe("The state label is factory_done, so there is nothing to stop or resume.");
  cleanup();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
  renderWithQuery(<RunControls run="r1" />);
  expect((await screen.findByRole("alert", {}, { timeout: 5000 })).textContent).toBe("Could not read the run state (500). Stop and Resume show once it loads.");
});

test("without a label_change the GitLab state picks the buttons, and a run waiting for approval shows no sentence", async () => {
  server({});
  renderWithQuery(<RunControls run="r1" state="factory_running" />);
  expect(await screen.findByRole("button", { name: "Stop" })).toBeTruthy();
  cleanup();
  server({});
  const { container } = renderWithQuery(<RunControls run="r1" state="factory_needs_approval" />);
  await waitFor(() => expect(container.querySelector("div")).not.toBeNull());
  expect(container.textContent).toBe("");
});
