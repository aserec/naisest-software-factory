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

describe("fake code host: reads for the week", () => {
  test("a change without a ticket has no closing line and keeps its title; edits and commits come from what a test filled", async () => {
    const host = fakeCodeHost();
    const { ref } = await host.openChange("factory/weekly-1", "Weekly", "Report");
    expect((await host.change(ref)).body).not.toContain("Closes #");
    expect((await host.change(ref)).title).toBe("Weekly");
    expect(await host.changeEdits(ref)).toEqual([]);
    host.edits.set(ref, [{ author: "ann", byFactory: false, field: "title", at: "2026-11-04T10:00:00Z" }]);
    host.commits.set(ref, [{ sha: "a1", byFactory: true }]);
    expect(await host.changeEdits(ref)).toHaveLength(1);
    expect(await host.changeEdits(ref, "2026-11-04T10:00:00Z")).toEqual([]);
    expect(await host.changeCommits(ref)).toEqual([{ sha: "a1", byFactory: true }]);
  });
  test("baseCommits gives the commits of baseLog after since, newest first", async () => {
    const host = fakeCodeHost();
    host.baseLog.push({ sha: "o", title: "old", message: "old", at: "2026-10-01T00:00:00Z" }, { sha: "n", title: "new", message: "new", at: "2026-11-03T00:00:00Z" }, { sha: "m", title: "mid", message: "mid", at: "2026-11-02T00:00:00Z" });
    expect((await host.baseCommits("2026-11-01T00:00:00Z")).map((c) => c.sha)).toEqual(["n", "m"]);
  });
});
