import { expect, test } from "vitest";
import { codeReviewLoop, precommitGate, type LoopDeps } from "./loops.js";
import type { ClaudeResult, Finding } from "./agents.js";

const B: Finding = { blocking: true, text: "bug" };

function fakeDeps(o: {
  reviews?: Finding[][];
  results?: Record<string, boolean[]>;
  fixResult?: Partial<ClaudeResult>;
}) {
  const reviews = [...(o.reviews ?? [])];
  const results = Object.fromEntries(Object.entries(o.results ?? {}).map(([k, v]) => [k, [...v]]));
  const fixCalls: string[] = [];
  const runCalls: string[] = [];
  const deps: LoopDeps & { fixCalls: string[]; runCalls: string[] } = {
    fixCalls,
    runCalls,
    review: async () => reviews.shift() ?? [],
    fix: async (f) => {
      fixCalls.push(f);
      return { sessionId: "s", isError: false, limitHit: false, costUsd: 0, tokens: { input: 0, output: 0 }, resultText: "", ...o.fixResult };
    },
    run: async (cmd) => {
      runCalls.push(cmd);
      return { ok: results[cmd]?.shift() ?? true, output: `out of ${cmd}` };
    },
  };
  return deps;
}
const cmds = { install: "pnpm install", lint: "pnpm lint", test: "pnpm test:unit", build: "pnpm build" };

test("review passes on round 2 after one fix", async () => {
  const deps = fakeDeps({ reviews: [[{ blocking: true, text: "null check" }], []] });
  expect(await codeReviewLoop(deps)).toEqual({ kind: "passed", rounds: 2 });
  expect(deps.fixCalls[0]).toContain("null check");
});
test("non-blocking findings alone pass", async () => expect(await codeReviewLoop(fakeDeps({ reviews: [[{ blocking: false, text: "nit" }]] }))).toEqual({ kind: "passed", rounds: 1 }));
test("three rounds with blocking findings block", async () => {
  const deps = fakeDeps({ reviews: [[B], [B], [B]] });
  expect(await codeReviewLoop(deps)).toEqual({ kind: "blocked", rounds: 3, open: ["bug"] });
  expect(deps.fixCalls).toHaveLength(2);
});
test("gate runs lint, test and build in order and reruns all three after a fix", async () => {
  const deps = fakeDeps({ results: { "pnpm lint": [false, true], "pnpm test:unit": [true, true], "pnpm build": [true, true] } });
  expect(await precommitGate(deps, cmds)).toEqual({ kind: "passed", rounds: 2 });
  expect(deps.runCalls).toEqual(["pnpm lint", "pnpm lint", "pnpm test:unit", "pnpm build"]);
});
test("gate blocks after 3 failing rounds and names the command", async () => {
  const deps = fakeDeps({ results: { "pnpm test:unit": [false, false, false] } });
  const r = await precommitGate(deps, cmds);
  expect(r).toMatchObject({ kind: "blocked", rounds: 3 });
  expect(JSON.stringify(r)).toContain("pnpm test:unit");
  expect(deps.fixCalls).toHaveLength(2);
  expect(deps.fixCalls[0]).toContain("out of pnpm test:unit");
});
test("a usage limit during a fix stops with limit, not blocked", async () => {
  const deps = fakeDeps({ reviews: [[B]], fixResult: { limitHit: true, sessionId: "s1" } });
  expect(await codeReviewLoop(deps)).toEqual({ kind: "limit", rounds: 1, sessionId: "s1" });
});
test("a failed author run blocks", async () => {
  const deps = fakeDeps({ reviews: [[B]], fixResult: { isError: true, resultText: "boom" } });
  const r = await codeReviewLoop(deps);
  expect(r.kind).toBe("blocked");
  expect(JSON.stringify(r)).toContain("author run failed");
});

// A resumed run continues its round count, so 3 rounds are never exceeded across a resume.
test("loops started at a later round stop at the same limit", async () => {
  const d = fakeDeps({ reviews: [[B], [B], [B]] });
  expect(await codeReviewLoop(d, 3, 3)).toEqual({ kind: "blocked", rounds: 3, open: ["bug"] });
  expect(d.fixCalls).toHaveLength(0);
  const g = fakeDeps({ results: { lint: [false, false, false] } });
  expect(await precommitGate(g, { install: "i", lint: "lint", test: "test", build: "build" }, 3, 3)).toMatchObject({ kind: "blocked", rounds: 3 });
  expect(g.fixCalls).toHaveLength(0);
});
test("a limit result carries the round it stopped in", async () => {
  const d = fakeDeps({ reviews: [[B]], fixResult: { limitHit: true, isError: true } });
  expect(await codeReviewLoop(d, 3, 2)).toMatchObject({ kind: "limit", rounds: 2 });
});
