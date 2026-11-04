import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { loadRouter, loadSeams } from "./config";
import { HARNESSES, HARNESS_NAMES } from "./harnesses";
import { HARNESS_HOMES } from "./seams";
import { sandboxDenyRead } from "./sandbox";

test("every registered harness home is on the sandbox deny list", () => {
  for (const h of Object.values(HARNESSES)) expect(sandboxDenyRead("/w/run/target")).toContain(join("/w/run", h.home));
});

test("the deny list keeps today's entries", () => {
  expect(sandboxDenyRead("/w/run/target")).toEqual(expect.arrayContaining(["/proc", "/w/run/claude-home", "/w/run/pi-home"]));
});

test("router.yml accepts exactly the registered harness names", () => {
  const dir = mkdtempSync(join(tmpdir(), "router-"));
  const file = join(dir, "router.yml");
  writeFileSync(file, "writer: { harness: codex, provider: tensorx, model: m }\n");
  expect(() => loadRouter(file, loadSeams())).toThrow(/harness/);
});

test("each adapter's home is the one the deny list is built from", () => {
  for (const n of HARNESS_NAMES) expect(HARNESSES[n].home).toBe(HARNESS_HOMES[n]);
});
