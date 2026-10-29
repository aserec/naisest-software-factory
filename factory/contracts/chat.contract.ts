import { describe, expect, test } from "vitest";
import type { Chat, Notice } from "../seams";

const NOTICES: Notice[] = ["needs_info", "needs_approval", "blocked", "done", "waiting", "watcher_ticket"];

// Every Chat must pass this: the fake on every push, the real adapter in the manual job.
// `failing` is a chat that cannot deliver, with the secret its error must not show. Fakes have none.
export function chatContract(make: () => Chat, failing?: () => { chat: Chat; secret: string }) {
  describe("chat contract", () => {
    test.each(NOTICES)("notify resolves for %s", async (kind) => {
      await expect(make().notify(kind, "Contract notice", ["A line."], "https://example.com/1")).resolves.toBeUndefined();
    });

    test.skipIf(!failing)("a failed notify never shows the secret", async () => {
      const { chat, secret } = failing!();
      const err = await chat.notify("done", "Contract notice", [], "https://example.com/1").then(() => undefined, (e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(String(err.message)).not.toContain(secret);
    });
  });
}
