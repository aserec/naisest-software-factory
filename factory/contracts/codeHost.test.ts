import { describe, expect, test } from "vitest";
import { fakeCodeHost } from "../fakes";
import { codeHostContract } from "./codeHost.contract";

codeHostContract(async () => ({ host: fakeCodeHost({ head: "head1" }), branch: "factory/8-x", ticket: "8" }));

describe("fake code host: changeComments", () => {
  test("the factory's own comment comes back flagged, newest first, and since compares times", async () => {
    const host = fakeCodeHost();
    const { ref } = await host.openChange("factory/8-x", "A", "t", "8");
    host.sayOnChange(ref, "ann", "hi", "2020-01-01T10:00:00.500Z");
    await host.commentChange(ref, "done");
    const all = await host.changeComments(ref);
    expect(all.map((c) => [c.author, c.byFactory, c.body.endsWith("done")])).toEqual([["factory-bot", true, true], ["ann", false, false]]);
    expect((await host.changeComments(ref, "2020-01-01T10:00:00Z")).map((c) => c.author)).toEqual(["factory-bot", "ann"]);
    expect(await host.changeComments(ref, "2020-01-01T10:00:01Z")).toHaveLength(1);
  });
});

describe("fake code host: changeOfTicket", () => {
  test("answers by branch prefix with the newest change; close and mergeByPerson change its state", async () => {
    const host = fakeCodeHost();
    await host.openChange("factory/123-x", "Other", "t", "123");
    expect(await host.changeOfTicket("12")).toBeUndefined();
    const a = await host.openChange("factory/12-a", "A", "t", "12");
    const b = await host.openChange("factory/12-b", "B", "t", "12");
    expect(await host.changeOfTicket("12")).toMatchObject({ ref: b.ref, open: true, merged: false });
    host.close(b.ref);
    expect(await host.changeOfTicket("12")).toMatchObject({ ref: b.ref, open: false, merged: false });
    host.mergeByPerson(a.ref);
    expect(host.changes.get(a.ref)).toMatchObject({ open: false, merged: true });
  });
});
