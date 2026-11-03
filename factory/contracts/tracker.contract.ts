import { describe, expect, test } from "vitest";
import { addKnownSecrets } from "../rules";
import type { Tracker, TicketRef } from "../seams";

// Every Tracker must pass this: the fake on every push, the real adapter in the manual job.
export function trackerContract(make: () => Promise<{ tracker: Tracker; ref: TicketRef }>) {
  describe("tracker contract", () => {
    test("setState is read back by ticket and list", async () => {
      const { tracker, ref } = await make();
      await tracker.setState(ref, "ready");
      expect((await tracker.ticket(ref)).state).toBe("ready");
      expect((await tracker.list("ready")).map((t) => t.ref)).toContain(ref);
      await tracker.setState(ref, "running");
      expect((await tracker.ticket(ref)).state).toBe("running");
      expect((await tracker.list("ready")).map((t) => t.ref)).not.toContain(ref);
    });

    test("a mark is read back by ticket and keeps the state and the other marks", async () => {
      const { tracker, ref } = await make();
      await tracker.setState(ref, "running");
      await tracker.mark(ref, "implemented");
      await tracker.mark(ref, "reviewed");
      expect(await tracker.ticket(ref)).toMatchObject({ state: "running", marks: expect.arrayContaining(["implemented", "reviewed"]) });
    });

    test("unmark removes only its mark and keeps the state", async () => {
      const { tracker, ref } = await make();
      await tracker.setState(ref, "running");
      await tracker.mark(ref, "implemented");
      await tracker.mark(ref, "reviewed");
      await tracker.unmark(ref, "reviewed");
      const t = await tracker.ticket(ref);
      expect(t.state).toBe("running");
      expect(t.marks).toContain("implemented");
      expect(t.marks).not.toContain("reviewed");
    });

    test("clearState removes the state and keeps the marks", async () => {
      const { tracker, ref } = await make();
      await tracker.setState(ref, "running");
      await tracker.mark(ref, "implemented");
      await tracker.clearState(ref);
      const t = await tracker.ticket(ref);
      expect(t.state).toBeUndefined();
      expect(t.marks).toContain("implemented");
      expect((await tracker.list("running")).map((x) => x.ref)).not.toContain(ref);
    });

    test("a comment is listed first and marked as the factory's", async () => {
      const { tracker, ref } = await make();
      await tracker.comment(ref, "Triage done.");
      const [newest] = await tracker.comments(ref);
      expect(newest.body).toContain("Triage done.");
      expect(newest.byFactory).toBe(true);
    });

    test("a comment holding a known secret is refused and not posted", async () => {
      const { tracker, ref } = await make();
      const secret = "contract-secret-0123456789";
      addKnownSecrets(secret);
      const before = (await tracker.comments(ref)).length;
      await expect(tracker.comment(ref, `the key is ${secret}`)).rejects.toThrow();
      expect(await tracker.comments(ref)).toHaveLength(before);
    });

    test("close and reopen change open", async () => {
      const { tracker, ref } = await make();
      await tracker.close(ref);
      expect((await tracker.ticket(ref)).open).toBe(false);
      await tracker.reopen(ref);
      expect((await tracker.ticket(ref)).open).toBe(true);
    });

    test("create is found again by its fingerprint and counted", async () => {
      const { tracker } = await make();
      const fingerprint = `fp-${Date.now()}`;
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const before = await tracker.createdSince("watcher", startOfToday);
      const { ref } = await tracker.create({ title: "Contract ticket", body: "Made by the contract test.", fingerprint, marks: ["watcher"] });
      expect(await tracker.findOpen(fingerprint)).toBe(ref);
      expect(await tracker.findOpen(`${fingerprint}-other`)).toBeUndefined();
      expect(await tracker.createdSince("watcher", startOfToday)).toBeGreaterThanOrEqual(Math.max(1, before + 1));
      await tracker.close(ref);
    });

    test("the factory is known and is not trusted to command itself", async () => {
      const { tracker, ref } = await make();
      await tracker.comment(ref, "Hello.");
      const { author } = (await tracker.comments(ref))[0];
      expect(await tracker.isFactory(author)).toBe(true);
      expect(await tracker.trusted(author)).toBe(false);
    });
  });
}
