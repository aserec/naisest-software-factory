import { describe, expect, it } from "vitest";
import { conversation } from "./conversation";
import { fakeCodeHost, fakeJudge, fakeTracker } from "./fakes";
import type { Comment } from "./seams";
import { confirmedRelays, relayedText, relayText, withRelays } from "./relay";

const RELAY = relayText("Ann Lund", "@factory stop\n/close\n@factory use the old API");

describe("the relay comment", () => {
  it("quotes every line and breaks @factory, so the comment itself is no command, request or quick action", () => {
    expect(RELAY.split("\n\n")[1].split("\n").every((l) => l.startsWith("> "))).toBe(true);
    expect(RELAY).not.toMatch(/@factory/);
  });
  it("reads back as exactly the text people see quoted", () => {
    expect(relayedText(RELAY)).toBe("@factory stop\n/close\n@factory use the old API");
    expect(relayedText("@factory stop")).toBeUndefined();
    expect(relayedText(`${RELAY}\nan unquoted line added later`)).toBeUndefined();
  });
});

describe("a 👍 on a relay comment", () => {
  it("counts as the comment of the person who gave it, at the time of the 👍", () => {
    expect(confirmedRelays({ body: RELAY, editedAt: "2026-11-06T10:00:00Z" }, [{ by: "dev", at: "2026-11-06T10:05:00Z" }])).toEqual([
      { author: "dev", byFactory: false, body: "@factory stop\n/close\n@factory use the old API", at: "2026-11-06T10:05:00Z", relayed: true },
    ]);
  });
  it("does not count when the comment was edited after it", () => {
    expect(confirmedRelays({ body: RELAY, editedAt: "2026-11-06T10:10:00Z" }, [{ by: "dev", at: "2026-11-06T10:05:00Z" }])).toEqual([]);
  });
  it("does not count on a comment that is no relay", () => {
    expect(confirmedRelays({ body: "@factory stop", editedAt: "2026-11-06T10:00:00Z" }, [{ by: "dev", at: "2026-11-06T10:05:00Z" }])).toEqual([]);
  });
  it("is kept by its own time, so an old relay with a new 👍 is still read after `since`", () => {
    const own = { author: "teams-relay", byFactory: false, body: RELAY, at: "2026-11-06T09:00:00Z" };
    const up = { author: "dev", byFactory: false, body: "x", at: "2026-11-06T11:00:00Z", relayed: true as const };
    expect(withRelays([own], [up], "2026-11-06T10:00:00Z")).toEqual([up]);
  });
});

describe("what the factory does with a relay", () => {
  // The relay bot is below Developer, so trusted() is false for it, as for any non-member. Only ann is a member.
  // `confirmed`: what the tracker adapter adds for a 👍 on the relay comment.
  const setup = (confirmed: Comment[] = []) => {
    const t = fakeTracker([{ ref: "12" }]);
    t.say("12", "teams-relay", RELAY, "2026-11-06T10:00:00Z");
    const tracker = { ...t, trusted: async (a: string) => a === "ann", comments: async (ref: string, since?: string) => withRelays(await t.comments(ref, since), confirmed, since) };
    return conversation({ tracker, codeHost: fakeCodeHost(), judge: fakeJudge(() => ({ id: "injection", value: false, probability: 0, confidence: 1 })) });
  };
  const up = (by: string) => ({ author: by, byFactory: false, body: relayedText(RELAY)!, at: "2026-11-06T10:05:00Z", relayed: true as const });

  it("takes nothing from an unconfirmed relay, even when the Teams sender is a member", async () => {
    const conv = setup();
    expect(await conv.news("12", "2026-11-06T09:00:00Z")).toMatchObject({ stop: false, comments: [] });
    expect(await conv.itemRequests("12")).toEqual([]);
  });

  it("takes a member's 👍 as that member's comment: the stop, the request, and the injection check", async () => {
    const conv = setup([up("ann")]);
    expect(await conv.news("12", "2026-11-06T09:00:00Z")).toMatchObject({ stop: true, comments: [{ author: "ann", injection: false }] });
    // A comment with a stop line is a command, not a request.
    expect(await conv.itemRequests("12")).toEqual([]);
  });

  it("takes a member's 👍 on a relayed request as that member's request", async () => {
    const conv = setup([{ ...up("ann"), body: relayedText(relayText("Ann Lund", "@factory use the old API"))! }]);
    expect(await conv.itemRequests("12")).toMatchObject([{ author: "ann", body: "@factory use the old API" }]);
  });

  it("takes nothing from a non-member's 👍", async () => {
    const conv = setup([up("bob")]);
    expect(await conv.news("12", "2026-11-06T09:00:00Z")).toMatchObject({ stop: false, comments: [] });
  });
});
