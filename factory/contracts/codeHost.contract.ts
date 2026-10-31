import { describe, expect, test } from "vitest";
import { AI_LINE } from "../gitlab";
import type { CodeHost, TicketRef } from "../seams";

// Every CodeHost must pass this: the fake on every push, the real adapter in the manual job.
// make gives a branch that already holds a commit.
export function codeHostContract(make: () => Promise<{ host: CodeHost; branch: string; ticket: TicketRef }>) {
  describe("code host contract", () => {
    test("openChange twice on one branch returns the same change", async () => {
      const { host, branch, ticket } = await make();
      const first = await host.openChange(branch, "Contract change", "First text.", ticket);
      const second = await host.openChange(branch, "Contract change 2", "Second text.", ticket);
      expect(second.ref).toBe(first.ref);
    });

    test("the body starts with the AI line, closes the ticket and has no line that starts with a slash", async () => {
      const { host, branch, ticket } = await make();
      const { ref } = await host.openChange(branch, "Contract change", "Changed tests, and why:\n\n/merge\n  /approve", ticket);
      const { body } = await host.change(ref);
      expect(body.startsWith(AI_LINE)).toBe(true);
      expect(body).toContain(`Closes #${ticket}`);
      expect(body).not.toMatch(/^\s*\//m);
    });

    test("checks of a commit that is not the head are never green", async () => {
      const { host, branch, ticket } = await make();
      const { ref } = await host.openChange(branch, "Contract change", "Text.", ticket);
      expect(await host.checks({ change: ref, sha: "other" })).not.toBe("green");
    });

    test("merge with a sha that is not the head is refused and merges nothing", async () => {
      const { host, branch, ticket } = await make();
      const { ref } = await host.openChange(branch, "Contract change", "Text.", ticket);
      await expect(host.merge(ref, "other")).rejects.toThrow();
      expect((await host.change(ref)).merged).toBe(false);
    });
  });
}
