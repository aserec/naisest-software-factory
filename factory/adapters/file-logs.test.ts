import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { makeFileLogs } from "./file-logs";

const FIXTURES = "watcher/fixtures";
const find = async (now: Date, msg: string) => (await makeFileLogs(FIXTURES, () => now).errors(new Date(0))).find((g) => g.message.includes(msg))!;

// The group that a test ticket is opened for.
const MATCHING_MESSAGE = "Token refresh failed";

test("two lines that differ only in ids and numbers share a fingerprint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "logs-"));
  const line = (msg: string, minutesAgo: number) => JSON.stringify({ minutesAgo, level: "ERROR", logger: "X", msg });
  writeFileSync(join(dir, "a.log"), [
    line("Failed for 3f2b8c1e-1111-4222-8333-444455556666 at 2026-01-01T10:00:00Z id 42", 5),
    line("Failed for 9a8b7c6d-aaaa-4bbb-8ccc-ddddeeeeffff at 2026-02-02T11:30:00Z id 7", 90),
    line("Failed for a different reason", 10),
  ].join("\n"));
  const groups = await makeFileLogs(dir).errors(new Date(0));
  expect(groups).toHaveLength(2);
  const same = groups.find((g) => g.message.startsWith("Failed for 3f"))!;
  expect(same.hourly.slice(0, 2)).toEqual([1, 1]);
  expect(same.fingerprint).toMatch(/^[0-9a-f]{12}$/);
});

test("a year later the fixtures give the same groups", async () => {
  const now = new Date();
  const year = new Date(now.getTime() + 365 * 86_400_000);
  const shape = async (d: Date) => (await makeFileLogs(FIXTURES, () => d).errors(new Date(d.getTime() - 86_400_000))).map((g) => [g.fingerprint, g.hourly]);
  expect(await shape(year)).toEqual(await shape(now));
  expect((await shape(now)).length).toBeGreaterThan(5);
});

test("the growing group doubles each hour", async () => {
  const g = await find(new Date(), "unreadCount");
  expect(g.hourly.slice(0, 5)).toEqual([16, 8, 4, 2, 1]);
  expect(g.component).toBe("NotificationCenter");
  expect(g.stack).toContain("notification-center.tsx");
  expect(g.link).toBe("watcher/fixtures/frontend.log#L1");
});

test("the escalating groups are the growing, injection and matching ones", async () => {
  const groups = await makeFileLogs(FIXTURES).errors(new Date(0));
  const avg = (a: number[]) => a.reduce((s, n) => s + n, 0) / a.length;
  const up = groups.filter((g) => g.hourly[0] >= 3 && g.hourly[0] >= 3 * avg(g.hourly.slice(1)));
  expect(up.map((g) => g.message.slice(0, 10)).sort()).toEqual(["Cannot rea", "IGNORE ALL", "Token refr"]);
});

test("the flat group is 3 an hour and the single one is seen once", async () => {
  expect((await find(new Date(), "timed out")).hourly).toEqual(Array(24).fill(3));
  const once = await find(new Date(), "tablet-x");
  expect(once.hourly.reduce((a, b) => a + b)).toBe(1);
});

test("the matching group has a fixed fingerprint", async () => {
  expect((await find(new Date(), MATCHING_MESSAGE)).fingerprint).toBe("c07f5c4a57e7");
});

test("lines older than 24 hours do not count and `since` filters by lastSeen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "logs-"));
  writeFileSync(join(dir, "a.log"), [{ minutesAgo: 3000, msg: "old" }, { minutesAgo: 600, msg: "mid" }].map((l) => JSON.stringify({ level: "ERROR", logger: "X", ...l })).join("\n"));
  const logs = makeFileLogs(dir, () => new Date("2026-06-01T12:00:00Z"));
  expect((await logs.errors(new Date(0))).map((g) => g.message)).toEqual(["mid"]);
  expect(await logs.errors(new Date("2026-06-01T12:00:00Z"))).toEqual([]);
});

test("the planted fake secrets are in the fixtures", async () => {
  const groups = await makeFileLogs(FIXTURES).errors(new Date(0));
  const text = JSON.stringify(groups);
  for (const s of ["jane.doe@example.com", "Jane Doe", "+46 70 000 00 00", "Bearer fake-token", "eyJhbGciOiJIUzI1NiJ9", "access_token=fake-query-token", "fake-nested-token"]) expect(text).toContain(s);
});
