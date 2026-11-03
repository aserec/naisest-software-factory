import { describe, expect, test } from "vitest";
import { AI_LINE } from "../gitlab";
import type { CodeHost, TicketRef } from "../seams";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

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
      await expect(host.merge(ref, "other", "[AM] chore: contract")).rejects.toThrow();
      expect((await host.change(ref)).merged).toBe(false);
    });

    test("a change targets the base branch", async () => {
      const { host, branch, ticket } = await make();
      const { ref } = await host.openChange(branch, "Contract change", "Text.", ticket);
      expect((await host.change(ref)).target).toBe(await host.baseBranch());
    });

    test("attach gives a link for the change text", async () => {
      const { host } = await make();
      expect(await host.attach("a.png", PNG)).not.toBe("");
    });

    test("readFile of a path that is not on the base branch is undefined", async () => {
      const { host } = await make();
      expect(await host.readFile("no/such/file.md")).toBeUndefined();
    });

    test("closeChange closes the change without merging it", async () => {
      const { host, branch, ticket } = await make();
      const { ref } = await host.openChange(branch, "Contract change", "Text.", ticket);
      await host.closeChange(ref);
      expect(await host.change(ref)).toMatchObject({ open: false, merged: false });
    });
  });
}
