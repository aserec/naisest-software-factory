import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { RunControls } from "./run-controls";
import { json, renderWithQuery } from "./test-utils";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const state = (o: object) => ({ cancelled: false, pending: [], ...o });
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

test("shows the reason when the server refuses", async () => {
  server({ label: "factory_running" }, new Response("already requested", { status: 409 }));
  renderWithQuery(<RunControls run="r1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
  fireEvent.click(screen.getAllByRole("button", { name: "Stop" }).at(-1)!);
  expect((await screen.findByRole("alert")).textContent).toBe("already requested");
});
