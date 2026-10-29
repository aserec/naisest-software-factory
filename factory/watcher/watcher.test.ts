import { expect, test } from "vitest";
import { makeFileLogs } from "../adapters/file-logs";
import type { ErrorGroup } from "../seams";
import { addKnownSecrets } from "../rules";
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
