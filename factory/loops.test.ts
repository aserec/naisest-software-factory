import { expect, test } from "vitest";
import { codeReviewLoop, MAX_AGENT_ROUNDS, precommitGate, type LoopDeps } from "./loops.js";
import type { Finding } from "./agents.js";
import type { HarnessResult } from "./seams.js";

const B: Finding = { blocking: true, text: "bug" };

function fakeDeps(o: {
  reviews?: Finding[][];
  results?: Record<string, boolean[]>;
  fixResult?: Partial<HarnessResult>;
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
      return { session: "s", ok: true, limitHit: false, stopped: false, costUsd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextTokens: 0, text: "", ...o.fixResult };
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
test("five rounds with blocking findings block", async () => {
  const deps = fakeDeps({ reviews: [[B], [B], [B], [B], [B]] });
  expect(await codeReviewLoop(deps)).toEqual({ kind: "blocked", rounds: 5, open: ["bug"] });
  expect(deps.fixCalls).toHaveLength(4);
});
test("gate runs lint, test and build in order and reruns all three after a fix", async () => {
  const deps = fakeDeps({ results: { "pnpm lint": [false, true], "pnpm test:unit": [true, true], "pnpm build": [true, true] } });
  expect(await precommitGate(deps, cmds)).toEqual({ kind: "passed", rounds: 2 });
  expect(deps.runCalls).toEqual(["pnpm lint", "pnpm lint", "pnpm test:unit", "pnpm build"]);
});
test("gate blocks after 5 failing rounds and names the command", async () => {
  const deps = fakeDeps({ results: { "pnpm test:unit": [false, false, false, false, false] } });
  const r = await precommitGate(deps, cmds);
  expect(r).toMatchObject({ kind: "blocked", rounds: 5 });
  expect(JSON.stringify(r)).toContain("pnpm test:unit");
  expect(deps.fixCalls).toHaveLength(4);
  expect(deps.fixCalls[0]).toContain("out of pnpm test:unit");
});
test("a usage limit during a fix stops with limit, not blocked", async () => {
  const deps = fakeDeps({ reviews: [[B]], fixResult: { limitHit: true, session: "s1" } });
  expect(await codeReviewLoop(deps)).toEqual({ kind: "limit", rounds: 1, sessionId: "s1" });
});
test("a failed author run blocks with the findings it was asked to fix and its own error", async () => {
  const deps = fakeDeps({ reviews: [[{ ...B, file: "a.ts" }]], fixResult: { ok: false, text: "boom" } });
  expect(await codeReviewLoop(deps)).toEqual({ kind: "blocked", rounds: 1, open: ["a.ts: bug", "author run failed: boom"] });
});

// A resumed run continues its round count, so 5 rounds are never exceeded across a resume.
test("loops started at a later round stop at the same limit", async () => {
  const d = fakeDeps({ reviews: [[B]] });
  expect(await codeReviewLoop(d, MAX_AGENT_ROUNDS, 5)).toEqual({ kind: "blocked", rounds: 5, open: ["bug"] });
  expect(d.fixCalls).toHaveLength(0);
  const g = fakeDeps({ results: { lint: [false] } });
  expect(await precommitGate(g, { install: "i", lint: "lint", test: "test", build: "build" }, MAX_AGENT_ROUNDS, 5)).toMatchObject({ kind: "blocked", rounds: 5 });
  expect(g.fixCalls).toHaveLength(0);
});
test("a stopped fix run stops the loop with its session, not blocked", async () => {
  const stopFix = { stopped: true, ok: false, session: "s9" };
  expect(await codeReviewLoop(fakeDeps({ reviews: [[B]], fixResult: stopFix }))).toEqual({ kind: "stopped", rounds: 1, sessionId: "s9" });
  const g = fakeDeps({ results: { lint: [false] }, fixResult: stopFix });
  expect(await precommitGate(g, { install: "i", lint: "lint", test: "test", build: "build" })).toEqual({ kind: "stopped", rounds: 1, sessionId: "s9" });
});
test("a limit result carries the round it stopped in", async () => {
  const d = fakeDeps({ reviews: [[B]], fixResult: { limitHit: true, ok: false } });
  expect(await codeReviewLoop(d, 3, 2)).toMatchObject({ kind: "limit", rounds: 2 });
});
