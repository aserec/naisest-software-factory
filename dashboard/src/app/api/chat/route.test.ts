import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ on: true }));
const model = vi.hoisted(() => ({ callModel: vi.fn() }));
vi.mock("@/server/control-user", () => ({ controlUser: async () => (session.on ? "ann" : new Response("sign in first", { status: 401 })) }));
vi.mock("@/server/auth", () => ({ auth: async () => (session.on ? { user: { name: "ann" } } : null) }));
vi.mock("software-factory/model-call", () => model);

process.env.DASHBOARD_DB = ":memory:";
const { getDb } = await import("@/server/db-instance");
const { GET, POST } = await import("./route");
const { POST: approve } = await import("./plans/[id]/route");

const post = (body: unknown) => POST(new Request("http://x/api/chat", { method: "POST", body: JSON.stringify(body) }));
const messages = async (r: Response) => ((await r.json()) as { messages: { author: string; text: string }[] }).messages;
const params = (id: string) => ({ params: Promise.resolve({ id }) });

const plan = { repo: "target" as const, summary: "fix it", steps: ["one"] };
beforeEach(() => {
  session.on = true;
  model.callModel.mockReset();
});

describe("chat", () => {
  it("refuses a post without a session and a get without one", async () => {
    session.on = false;
    expect((await post({ path: "/a", text: "hi" })).status).toBe(401);
    expect((await GET(new Request("http://x/api/chat?path=/a"))).status).toBe(401);
  });

  it("refuses a bad path or text", async () => {
    for (const body of [{ path: "a", text: "hi" }, { path: "/a b", text: "hi" }, { path: `/${"a".repeat(200)}`, text: "hi" }, { path: "/a", text: "" }, { path: "/a", text: "x".repeat(4001) }, { path: "/a" }]) {
      expect((await post(body)).status).toBe(400);
    }
    expect((await GET(new Request("http://x/api/chat?path=nope"))).status).toBe(400);
  });

  it("stores the question and the answer and returns both", async () => {
    model.callModel.mockResolvedValue("all fine");
    const r = await post({ path: "/ok", text: "how is it?" });
    expect(r.status).toBe(200);
    expect((await messages(r)).map((m) => [m.author, m.text])).toEqual([["ann", "how is it?"], ["agent", "all fine"]]);
    expect((await messages(await GET(new Request("http://x/api/chat?path=/ok")))).length).toBe(2);
    expect(model.callModel.mock.calls[0][4]).toEqual({ maxTokens: 2000 });
  });

  it("stores the failure as an agent message and answers 502", async () => {
    model.callModel.mockRejectedValue(new Error("HTTP 500"));
    const r = await post({ path: "/bad", text: "hi" });
    expect(r.status).toBe(502);
    expect(getDb().chat("/bad", 10).map((m) => m.text)).toEqual(["hi", "The model call failed: Error: HTTP 500"]);
  });
});

describe("plans", () => {
  const proposed = () => getDb().addChatMessage({ path: "/p", author: "agent", text: "plan", plan, planUser: "ann" }).plan!.id;

  it("approves once, then refuses with 409", async () => {
    const id = proposed();
    const req = () => approve(new Request("http://x", { method: "POST" }), params(id));
    expect((await req()).status).toBe(200);
    expect((await req()).status).toBe(409);
  });

  it("refuses an approval without a session", async () => {
    session.on = false;
    expect((await approve(new Request("http://x", { method: "POST" }), params("nope"))).status).toBe(401);
  });
});
