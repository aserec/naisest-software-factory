import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { RunControls } from "./run-controls";
import { json, renderWithQuery } from "./test-utils";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const state = (o: object) => ({ actions: [], restarted: false, pending: [], ...o });
const names = () => screen.queryAllByRole("button").map((b) => b.textContent);

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

test("shows the actions the server allows, in its order", async () => {
  server({ state: "stopped", actions: ["resume", "restart"] });
  renderWithQuery(<RunControls run="r1" />);
  await screen.findByRole("button", { name: "Resume" });
  expect(names()).toEqual(["Resume", "Restart"]);
  cleanup();
  server({ state: "running", cancelled: true, actions: ["restart"] });
  renderWithQuery(<RunControls run="r1" />);
  await screen.findByRole("button", { name: "Restart" });
  expect(names()).toEqual(["Restart"]);
});

test("a waiting request shows in place of the buttons", async () => {
  server({ state: "running", pending: ["stop"] });
  renderWithQuery(<RunControls run="r1" />);
  expect((await screen.findByText(/Stop requested/)).textContent).toBeTruthy();
  expect(names()).toEqual([]);
});

test("a run with a done restart shows nothing, not even the sentence", async () => {
  server({ state: "stopped", restarted: true });
  const { container } = renderWithQuery(<RunControls run="r1" />);
  await waitFor(() => expect(container.firstChild).not.toBeNull()); // the state arrived
  expect(container.textContent).toBe("");
});

test("shows the reason when the server refuses", async () => {
  server({ state: "running", actions: ["stop"] }, new Response("already requested", { status: 409 }));
  renderWithQuery(<RunControls run="r1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
  fireEvent.click(screen.getAllByRole("button", { name: "Stop" }).at(-1)!);
  expect((await screen.findByRole("alert")).textContent).toBe("Stop is already requested.");
});

test("says why there are no buttons, and that the state could not be read", async () => {
  server({ state: "done" });
  renderWithQuery(<RunControls run="r1" />);
  expect((await screen.findByText(/nothing to stop/)).textContent).toBe("The work item is Done, so there is nothing to stop or resume.");
  cleanup();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
  renderWithQuery(<RunControls run="r1" />);
  expect((await screen.findByRole("alert", {}, { timeout: 5000 })).textContent).toBe("Could not load the run state, so Stop and Resume are hidden.Retry");
});

test("a run waiting for approval shows no buttons and no sentence", async () => {
  const f = server({ state: "needs_approval" });
  const { container } = renderWithQuery(<RunControls run="r1" />);
  await waitFor(() => expect(f).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 50)); // let the state answer render
  expect(container.innerHTML).toBe("");
});
