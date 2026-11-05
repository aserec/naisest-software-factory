import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { RunControls } from "./run-controls";
import { json, renderWithQuery } from "./test-utils";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const state = (o: object) => ({ actions: [], restarted: false, pending: [], refusals: {}, ...o });
const names = () => screen.queryAllByRole("button").map((b) => b.textContent);
// The buttons a person can press now; the others are disabled.
const enabled = () => screen.queryAllByRole("button").filter((b) => !(b as HTMLButtonElement).disabled).map((b) => b.textContent);

// A fake server: GET state returns `s`, a POST answers `post`.
function server(s: object, post = new Response("{}")) {
  const f = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === "POST" ? post : json(state(s))));
  vi.stubGlobal("fetch", f);
  return f;
}

test("Stop asks first, then posts the stop for the run", async () => {
  const f = server({ state: "running", actions: ["stop"] });
  renderWithQuery(<RunControls run="r 1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
  expect(f.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false); // the dialog only asks
  fireEvent.click(screen.getAllByRole("button", { name: "Stop" }).at(-1)!); // the one in the dialog
  await waitFor(() => expect(f).toHaveBeenCalledWith("/api/runs/r%201/stop", { method: "POST" }));
});

test("Cancel closes the confirm, starts with focus, and posts nothing", async () => {
  const f = server({ state: "running", actions: ["stop"] });
  renderWithQuery(<RunControls run="r1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
  const cancel = await screen.findByRole("button", { name: "Cancel" });
  await waitFor(() => expect(document.activeElement).toBe(cancel));
  fireEvent.click(cancel);
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(f.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
});

test("shows every action, and enables only the ones the server allows", async () => {
  server({ state: "stopped", actions: ["resume", "restart"] });
  renderWithQuery(<RunControls run="r1" />);
  await screen.findByRole("button", { name: "Resume" });
  expect(names()).toEqual(["Stop", "Resume", "Restart", "Set to Ready"]);
  expect(enabled()).toEqual(["Resume", "Restart"]);
});

test("a disabled button says why on hover", async () => {
  server({ state: "blocked", actions: ["ready"], refusals: { stop: "run is not running" } });
  renderWithQuery(<RunControls run="r1" />);
  const stop = await screen.findByRole("button", { name: "Stop" });
  fireEvent.pointerMove(stop.parentElement!);
  fireEvent.focus(stop.parentElement!);
  expect((await screen.findByRole("tooltip")).textContent).toBe("Disabled: run is not running.");
});

test("Set to Ready asks first, then posts ready for the run", async () => {
  const f = server({ state: "blocked", actions: ["ready"] });
  renderWithQuery(<RunControls run="r1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Set to Ready" }));
  fireEvent.click(screen.getAllByRole("button", { name: "Set to Ready" }).at(-1)!);
  await waitFor(() => expect(f).toHaveBeenCalledWith("/api/runs/r1/ready", { method: "POST" }));
});

test("a waiting request shows beside the disabled buttons", async () => {
  server({ state: "running", pending: ["stop"] });
  renderWithQuery(<RunControls run="r1" />);
  expect((await screen.findByText(/Stop requested/)).textContent).toBeTruthy();
  expect(enabled()).toEqual([]);
});

test("shows the reason when the server refuses", async () => {
  server({ state: "running", actions: ["stop"] }, new Response("already requested", { status: 409 }));
  renderWithQuery(<RunControls run="r1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
  fireEvent.click(screen.getAllByRole("button", { name: "Stop" }).at(-1)!);
  expect((await screen.findByRole("alert")).textContent).toBe("Stop is already requested.");
});

test("says the buttons are hidden when the state could not be read", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
  renderWithQuery(<RunControls run="r1" />);
  expect((await screen.findByRole("alert", {}, { timeout: 5000 })).textContent).toBe("Could not load the run state, so the run buttons are hidden.Retry");
});
