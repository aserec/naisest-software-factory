import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AgentChat } from "./agent-chat";
import { json, renderWithQuery } from "./test-utils";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const plan = (state: string, o: object = {}) => ({ id: "p1", path: "/runs/r1", repo: "factory", summary: "Fix the retry", steps: ["Edit retry.ts", "Open a PR"], state, user: "ann", at: "2026-11-08T10:00:00Z", ...o });
const msg = (seq: number, author: string, text: string, p?: object) => ({ seq, path: "/runs/r1", author, at: "2026-11-08T10:0" + seq + ":00Z", text, ...(p && { plan: p }) });

// A fake server: GET answers `messages`; a POST goes to `post`.
function server(messages: object[], post: (url: string, body: unknown) => Promise<Response> | Response = () => json({ messages })) {
  const f = vi.fn(async (url: string, init?: RequestInit) => (init?.method === "POST" ? post(url, JSON.parse(String(init.body ?? "null"))) : json({ messages })));
  vi.stubGlobal("fetch", f);
  return f;
}

test("shows the messages for the path in order, each with its author", async () => {
  const f = server([msg(1, "ann", "why did it fail?"), msg(2, "agent", "The test timed out.")]);
  renderWithQuery(<AgentChat path="/runs/r1" />);
  await screen.findByText("The test timed out.");
  expect(f).toHaveBeenCalledWith("/api/chat?path=%2Fruns%2Fr1", undefined);
  expect(screen.getAllByText(/^why did it fail\?$|^The test timed out\.$/).map((e) => e.textContent)).toEqual(["why did it fail?", "The test timed out."]);
  expect(screen.getByText("ann")).toBeTruthy();
  expect(screen.getByText("agent")).toBeTruthy();
});

test("a proposed plan shows its steps, repo and Go; Go posts the approval", async () => {
  const f = server([msg(1, "agent", "Here is a plan.", plan("proposed"))]);
  renderWithQuery(<AgentChat path="/runs/r1" />);
  expect(await screen.findByText("Fix the retry")).toBeTruthy();
  expect(screen.getAllByRole("listitem").map((e) => e.textContent)).toEqual(["Edit retry.ts", "Open a PR"]);
  expect(screen.getByText(/factory · proposed/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Go" }));
  await waitFor(() => expect(f).toHaveBeenCalledWith("/api/chat/plans/p1", { method: "POST" }));
});

test("a refused approval shows the server's reason", async () => {
  server([msg(1, "agent", "Plan.", plan("proposed"))], () => new Response("Already approved by bob.", { status: 409 }));
  renderWithQuery(<AgentChat path="/runs/r1" />);
  fireEvent.click(await screen.findByRole("button", { name: "Go" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Already approved by bob.");
});

test("a running plan has no Go and names who approved it; a done plan links its result", async () => {
  server([msg(1, "agent", "Running.", plan("running", { approvedBy: "bob" })), msg(2, "agent", "Done.", plan("done", { id: "p2", approvedBy: "bob", result: "https://git.example/pr/9" }))]);
  renderWithQuery(<AgentChat path="/runs/r1" />);
  await screen.findByText("Running.");
  expect(screen.queryByRole("button", { name: "Go" })).toBeNull();
  expect(screen.getAllByText("Approved by bob")).toHaveLength(2);
  expect(screen.getByRole("link", { name: "https://git.example/pr/9" }).getAttribute("href")).toBe("https://git.example/pr/9");
});

test("sending posts the path and text, disables the input and says Thinking... until the answer comes", async () => {
  let answer!: (r: Response) => void;
  const f = server([], () => new Promise<Response>((r) => (answer = r)));
  renderWithQuery(<AgentChat path="/runs/r1" />);
  const input = (await screen.findByLabelText("Message")) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "what failed?" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText("Thinking...");
  expect(input.disabled).toBe(true);
  expect(JSON.parse(String(f.mock.calls.find(([, i]) => i?.method === "POST")![1]!.body))).toEqual({ path: "/runs/r1", text: "what failed?" });
  answer(json({ messages: [msg(1, "ann", "what failed?"), msg(2, "agent", "A timeout.")] }));
  await screen.findByText("A timeout.");
  expect(screen.queryByText("Thinking...")).toBeNull();
  expect(input.disabled).toBe(false);
  expect(input.value).toBe("");
});

test("a model failure (502) still shows the stored messages", async () => {
  server([], () => new Response(JSON.stringify({ messages: [msg(1, "agent", "The model call failed: boom")] }), { status: 502 }));
  renderWithQuery(<AgentChat path="/runs/r1" />);
  fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "hi" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByText("The model call failed: boom")).toBeTruthy();
});
