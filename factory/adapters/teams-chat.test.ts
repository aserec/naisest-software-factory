import { expect, test, vi } from "vitest";
import { chatContract } from "../contracts/chat.contract";
import { makeTeamsChat } from "./teams-chat";

const ok = () => vi.fn().mockResolvedValue({ ok: true, status: 202 }) as unknown as typeof fetch;
const URL = "https://secret.example/hook";

// The Teams adapter against a stubbed fetch: one that fails with a bad status, one that throws with the URL in its message.
chatContract(
  () => makeTeamsChat(URL, ok()),
  () => ({ chat: makeTeamsChat(URL, vi.fn().mockRejectedValue(new Error(`Invalid URL: ${URL}`)) as unknown as typeof fetch), secret: "secret" }),
);

test("a bad status fails without the webhook URL", async () => {
  const f = vi.fn().mockResolvedValue({ ok: false, status: 400 }) as unknown as typeof fetch;
  const err = await makeTeamsChat(URL, f).notify("blocked", "T", [], "https://x").catch((e) => e);
  expect(err.message).toContain("400");
  expect(err.message).not.toContain("secret");
});

test("notify posts the card for the notice to the webhook", async () => {
  const f = ok();
  await makeTeamsChat(URL, f).notify("watcher_ticket", "Add a test", ["Found by the watcher"], "https://x/1");
  const [to, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
  expect(to).toBe(URL);
  const card = JSON.parse(init.body).attachments[0].content;
  expect(card.body[0].text).toBe("New watcher ticket: Add a test");
  expect(card.actions[0]).toMatchObject({ title: "Open", url: "https://x/1" });
});
