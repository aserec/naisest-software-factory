import { NotSetUp } from "../not-set-up";
import type { Tracker } from "../seams";
import type { Seed } from "./tracker.contract";

// A tracker in memory: every target holds the same seeded work items.
export const fakeTracker = (seed: Seed[], { setUp = true } = {}): Tracker => ({
  name: "Fake",
  async rows(targets) {
    if (!setUp) throw new NotSetUp("the fake is not set up");
    return targets.flatMap((t) => seed.map((s) => ({ target: t.name, ...s, url: this.ticketUrl(t, s.ticket), updatedAt: "2026-11-04T10:00:00Z" })));
  },
  ticketUrl: (t, ticket) => `https://tracker.test/${t.name}/${ticket}`,
});
