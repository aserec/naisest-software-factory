import { describe, expect, it } from "vitest";
import { fakeTracker, FAKE_FACTORY } from "./fakes";
import { ownTickets } from "./owner";

describe("ownTickets", () => {
  it("claims a ticket it sets running, so another factory no longer sees it", async () => {
    const base = fakeTracker([{ ref: "1", state: "ready" }]);
    await ownTickets(base, "a").setState("1", "running");
    expect(base.tickets.get("1")?.owner).toBe("a");
    expect(await ownTickets(base, "a").list("running")).toHaveLength(1);
    expect(await ownTickets(base, "b").list("running")).toHaveLength(0);
  });

  it("hides another factory's closed tickets too", async () => {
    const base = fakeTracker([{ ref: "1", state: "stopped", open: false, owner: "a" }]);
    expect(await ownTickets(base, "b").listClosed(10)).toHaveLength(0);
    expect(await ownTickets(base, "a").listClosed(10)).toHaveLength(1);
  });

  it("lets any factory take a ticket a person set ready, but not one its owner set ready again", async () => {
    const base = fakeTracker([{ ref: "1", state: "ready", owner: "a" }, { ref: "2", state: "ready", owner: "a" }]);
    base.startedBy = async (ref) => (ref === "1" ? "alice" : FAKE_FACTORY);
    expect((await ownTickets(base, "b").list("ready")).map((t) => t.ref)).toEqual(["1"]);
    expect((await ownTickets(base, "a").list("ready")).map((t) => t.ref)).toEqual(["1", "2"]);
  });

  it("treats a ticket with no owner as free", async () => {
    const base = fakeTracker([{ ref: "1", state: "running" }]);
    expect(await ownTickets(base, "b").list("running")).toHaveLength(1);
  });
});
