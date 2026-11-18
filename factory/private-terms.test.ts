// The repo is mirrored to a public GitHub repo. `.private-terms` (gitignored, one word per line) lists
// client, host and personal names that must stay off it. Without that file the test skips.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";

const root = new URL("..", import.meta.url).pathname;
const listPath = `${root}.private-terms`;
const terms = existsSync(listPath)
  ? readFileSync(listPath, "utf8").split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"))
  : [];

test.skipIf(terms.length === 0)("no tracked file holds a private term", () => {
  const args = ["grep", "-IinF", ...terms.flatMap((term) => ["-e", term])];
  let hits = "";
  try {
    hits = execFileSync("git", args, { cwd: root, encoding: "utf8" });
  } catch (error) {
    // git grep exits 1 when nothing matches.
    if ((error as { status?: number }).status !== 1) throw error;
  }
  expect(hits).toBe("");
});
