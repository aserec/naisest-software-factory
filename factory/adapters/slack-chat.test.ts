import { expect, test, vi } from "vitest";
import { chatContract } from "../contracts/chat.contract";
import { makeSlackChat } from "./slack-chat";

const ok = () => vi.fn().mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch;
const URL = "https://hooks.slack.com/services/T0/B0/secret";

// The Slack adapter against a stubbed fetch: one that fails with a bad status, one that throws with the URL in its message.
chatContract(
  () => makeSlackChat(URL, ok()),
  () => ({ chat: makeSlackChat(URL, vi.fn().mockRejectedValue(new Error(`Invalid URL: ${URL}`)) as unknown as typeof fetch), secret: "secret" }),
);

test("a bad status fails without the webhook URL", async () => {
  const f = vi.fn().mockResolvedValue({ ok: false, status: 404 }) as unknown as typeof fetch;
  const err = await makeSlackChat(URL, f).notify("blocked", "T", [], "https://x").catch((e) => e);
  expect(err.message).toBe("Slack webhook failed with status 404");
});

test("notify posts the notice, its lines and an Open link, with Slack markup escaped", async () => {
  const f = ok();
  await makeSlackChat(URL, f).notify("blocked", "Fix <b> & co", ["Tests fail"], "https://x/1");
  const [to, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
  expect(to).toBe(URL);
  expect(JSON.parse(init.body).text).toBe("*Blocked: Fix &lt;b&gt; &amp; co*\nTests fail\n<https://x/1|Open>");
});
