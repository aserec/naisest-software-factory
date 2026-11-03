import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ciContract } from "../contracts/ci.contract";
import { makeLocalCi } from "./local-ci";

const tmp = () => mkdtempSync(join(tmpdir(), "lci-"));
function setup(o: Record<string, string> = {}) {
  const dir = tmp(), queue = join(dir, "queue"), runs = join(dir, "runs");
  writeFileSync(join(dir, "gl"), "glpat-x\n");
  const env = { FACTORY_PIPELINE: "build", FACTORY_TARGET: "react_frontend", FACTORY_WORK_ITEM_IID: "8", FACTORY_RUN_ID: "5", FACTORY_GITLAB_TOKEN: join(dir, "gl"), ...o };
  return { ci: makeLocalCi(env, dir, { queue, runs }), queue, runs };
}
// A build run the worker saved; ok marks that its decision step ended well.
function saved(runs: string, id: string, ok: boolean) {
  mkdirSync(join(runs, id, "run"), { recursive: true });
  writeFileSync(join(runs, id, "run", "record.json"), JSON.stringify({ steps: [], runId: `r${id}` }));
  writeFileSync(join(runs, id, "run", "stop"), "prepare-patch");
  if (ok) writeFileSync(join(runs, id, "ok"), "");
}

ciContract(async () => {
  const { ci, runs } = setup();
  saved(runs, "41", false);
  return { ci, ticket: "8", secret: "FACTORY_GITLAB_TOKEN", foreignRun: "41" };
});

test("vars map the step variables, and bad values are refused", () => {
  expect(setup({ FACTORY_PIPELINE: "finish", FACTORY_MR_IID: "3", FACTORY_BUILD_PIPELINE_ID: "41", FACTORY_SKIP_APPLY: "1" }).ci.vars).toEqual({ ticket: "8", change: "3", skipApply: true, buildRun: "41", run: "5", runUrl: "" });
  expect(() => setup({ FACTORY_RUN_ID: "5; rm -rf /" })).toThrow(/FACTORY_RUN_ID/);
  expect(() => setup({ FACTORY_WORK_ITEM_IID: "../8" })).toThrow(/FACTORY_WORK_ITEM_IID/);
});

test("start leaves the run in the queue for the worker", async () => {
  const { ci, queue } = setup();
  await ci.start({ kind: "finish", ticket: "8", change: "3", buildRun: "5" });
  const [f] = readdirSync(queue);
  expect(JSON.parse(readFileSync(join(queue, f), "utf8"))).toEqual({ kind: "finish", ticket: "8", change: "3", buildRun: "5", target: "react_frontend" });
});

test("buildRecord and restoreRun take only a run the worker marked ok, and restoreRun drops the stop file", async () => {
  const { ci, runs } = setup();
  saved(runs, "41", true);
  expect(await ci.buildRecord("41")).toMatchObject({ runId: "r41" });
  await expect(ci.buildRecord("../41")).rejects.toThrow(/not a factory build run/);
  await expect(ci.buildRecord("42")).rejects.toThrow(/not a factory build run/);
  const cwd = tmp(), before = process.cwd();
  process.chdir(cwd);
  try { await ci.restoreRun("41"); } finally { process.chdir(before); }
  expect(existsSync(join(cwd, "run", "record.json"))).toBe(true);
  expect(existsSync(join(cwd, "run", "stop"))).toBe(false);
});
