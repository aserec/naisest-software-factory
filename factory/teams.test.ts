import { expect, test, vi } from "vitest";
import { buildCard, sendCard } from "./teams";

test("cards use the Adaptive Card attachment format", () => {
  const c: any = buildCard("needs_approval", "react_frontend #8", ["size: 412 lines"], "https://x");
  expect(c.type).toBe("message");
  expect(c.attachments[0].contentType).toBe("application/vnd.microsoft.card.adaptive");
  const card = c.attachments[0].content;
  expect(card.body[0].text).toBe("Needs review and merge: react_frontend #8");
  expect(card.body[1]).toMatchObject({ text: "size: 412 lines", wrap: true });
  expect(card.actions[0]).toEqual({ type: "Action.OpenUrl", title: "Open", url: "https://x" });
});
test("sendCard throws with the status and never shows the webhook URL", async () => {
  const f = vi.fn().mockResolvedValue({ ok: false, status: 400 });
  const err = await sendCard("https://secret.example/hook", {}, f as any).catch((e) => e);
  expect(err.message).toContain("400");
  expect(err.message).not.toContain("secret");
});
test("sendCard posts the card as JSON", async () => {
  const f = vi.fn().mockResolvedValue({ ok: true, status: 202 });
  await sendCard("https://h", { a: 1 }, f as any);
  expect(f).toHaveBeenCalledWith("https://h", expect.objectContaining({ method: "POST", body: '{"a":1}' }));
});
test("a fetch error never shows the webhook URL", async () => {
  const f = vi.fn().mockRejectedValue(new Error("Invalid URL: https://secret.example/hook"));
  const err = await sendCard("https://secret.example/hook", {}, f as any).catch((e) => e);
  expect(err.message).toBe("Teams webhook request failed");
  expect(err.cause).toBeUndefined();
});
