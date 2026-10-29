import { expect, test } from "vitest";
import { makeFileLogs } from "../adapters/file-logs";
import type { ErrorGroup } from "../seams";
import { addKnownSecrets, HELD_SECRET } from "../rules";
import { escalating } from "./escalation";
import { scrub, scrubGroup } from "./scrub";

const NOW = new Date("2026-06-01T12:00:00Z");
const groups = () => makeFileLogs("watcher/fixtures", () => NOW).errors(new Date(0));

// Fake customer data planted in watcher/fixtures/frontend.log.
const PLANTED = [
  "jane.doe@example.com", "Jane Doe", "+46 70 000 00 00",
  "fake-token-0000000000000000", "fake-nested-token-2222", "fake-query-token-1111",
  "eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJmYWtlLXVzZXIifQ", "ZmFrZS1zaWduYXR1cmU",
];

test("only the growing, matching and injection groups escalate", async () => {
  const hot = (await groups()).filter(escalating).map((g) => g.component).sort();
  expect(hot).toEqual(["AuthProvider", "NotificationCenter", "NotificationToasts"]);
  const first = (await groups()).filter(escalating).find((g) => g.component === "AuthProvider")!;
  expect(first.message).toContain("Token refresh failed");
});

test("one event never escalates, three in the last hour do", () => {
  const g = (hourly: number[]) => ({ hourly }) as ErrorGroup;
  expect(escalating(g([1, ...Array(23).fill(0)]))).toBe(false);
  expect(escalating(g([3, ...Array(23).fill(0)]))).toBe(true);
  expect(escalating(g([4, ...Array(23).fill(2)]))).toBe(false);
});

test("scrubbed groups hold none of the planted values", async () => {
  const all = await groups();
  // The planted values really are there before scrubbing.
  const before = JSON.stringify(all);
  for (const p of PLANTED) expect(before).toContain(p);
  const after = JSON.stringify(all.map(scrubGroup));
  for (const p of PLANTED) expect(after).not.toContain(p);
});

test("scrub keeps ordinary error text", () => {
  expect(scrub("TypeError at List.tsx:42")).toBe("TypeError at List.tsx:42");
  expect(scrub("a@b.co and token=abc and 0123456789abcdef0123 and +1 555-123-4567")).toBe("[removed] and token=[removed] and [removed] and [removed]");
  expect(scrub(`glpat-${"a".repeat(20)}`)).toBe("[removed]");
  expect(scrub('{"password": "hunter2", "level": "ERROR"}')).toBe('{"password": "[removed]", "level": "ERROR"}');
});

test("a secret this process holds drops the whole text", () => {
  addKnownSecrets("held-secret-value-123456");
  expect(scrub("boom held-secret-value-123456")).toBe("[removed]");
});

test("a text that holds the placeholder literal and a held secret still drops whole", () => {
  addKnownSecrets("held-secret-value-123456");
  expect(scrub(`${HELD_SECRET} then held-secret-value-123456`)).toBe("[removed]");
});

test("very long runs finish fast and keep nothing planted", () => {
  for (const run of ["a", "a.", "a1", "1 ", "a@", "-", "eyJa.b.", "name", "a@b.c("]) {
    const text = `Login jane.doe@example.com token=fake-query-token-1111 Bearer fake-nested-token-2222 ${run.repeat(100_000)}`;
    const t0 = Date.now();
    const out = scrub(text);
    expect(Date.now() - t0).toBeLessThan(500);
    for (const p of ["jane.doe@example.com", "fake-query-token-1111", "fake-nested-token-2222"]) expect(out).not.toContain(p);
    expect(out.length).toBeLessThan(25_000);
  }
});

test("a cut at the size limit leaves no half of a customer value", () => {
  for (const planted of ['{"name": "Jane Doe", "x": 1}', "jane.doe@example.com (Jane Doe, +46 70 000 00 00)"]) {
    // The input is cut right after "Jane ", so a cut before scrubbing would leave it.
    const out = scrub(" ".repeat(20_000 - planted.indexOf("Doe")) + planted + " ".repeat(30_000));
    expect(out).toContain("[truncated]");
    expect(out).not.toMatch(/jane/i);
  }
});
