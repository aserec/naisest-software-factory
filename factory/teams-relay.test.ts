import { describe, expect, it } from "vitest";
import { relayText } from "../dashboard/src/server/teams-relay";
import { conversation } from "./conversation";
import { fakeCodeHost, fakeJudge, fakeTracker } from "./fakes";

// The Teams bridge (dashboard/src/server/teams-bridge.ts) posts as a relay bot below Developer. This is the trust decision:
// the factory treats that bot like any non-member, so a Teams message never reaches an agent and never commands a run.
describe("what the factory does with a relay", () => {
  // The relay bot is below Developer, so trusted() is false for it, as for any non-member.
  const setup = () => {
    const t = fakeTracker([{ ref: "12" }]);
    const tracker = { ...t, trusted: async (a: string) => a === "ann" };
    return { t, conv: conversation({ tracker, codeHost: fakeCodeHost(), judge: fakeJudge(() => ({ id: "injection", value: false, probability: 0, confidence: 1 })) }) };
  };

  it("gives a relay to no agent and takes no request from it, even when the Teams sender is a member", async () => {
    const { t, conv } = setup();
    t.say("12", "teams-relay", relayText("ann", "@factory stop\n@factory use the old API"), "2026-11-06T10:00:00Z");
    const news = await conv.news("12", "2026-11-06T09:00:00Z");
    expect(news).toMatchObject({ stop: false, comments: [] });
    expect(await conv.itemRequests("12")).toEqual([]);
  });

  it("still takes the same words from the member on the work item (control)", async () => {
    const { t, conv } = setup();
    t.say("12", "ann", "@factory use the old API", "2026-11-06T10:00:00Z");
    expect((await conv.news("12", "2026-11-06T09:00:00Z")).comments).toHaveLength(1);
  });
});
