import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { emit } from "./emit";
import { eventsOfType, MAX_FIELD } from "./run-events";
import { addKnownSecrets } from "./rules";
import { fakeWorld } from "./steps/test-helpers";

// A world whose run dir is a fresh temp dir. emit writes events.jsonl next to the clone.
const world = (runId?: string) => {
  const w = fakeWorld();
  const runDir = mkdtempSync(join(tmpdir(), "emit-"));
  w.ctx.dir = join(runDir, "target");
  if (runId) w.ctx.record = { ...w.ctx.record, runId };
  const dash = w.ctx.dashboard as ReturnType<typeof import("./fakes").fakeDashboard>;
  return { w, dash, file: join(runDir, "events.jsonl") };
};

// Review Focus 2: no secret leaves the runner in an event.
test("every string in an event is masked, in the dashboard and in events.jsonl", () => {
  const token = "gitlab-token-for-emit-0123456789";
  addKnownSecrets(token); // as makeContext does with FACTORY_GITLAB_TOKEN
  const { w, dash, file } = world("run-1");
  w.ctx.ci.vars.job = "77";
  w.ctx.step = "triage";
  const id = emit(w.ctx, "step_start", { prompt: `echo ${token}`, deep: [{ x: ["glpat-abcdefghijklmnopqrstuv"] }] });
  const text = JSON.stringify(dash.events) + readFileSync(file, "utf8");
  for (const secret of [token, "glpat-abcdefghijklmnopqrstuv"]) expect(text).not.toContain(secret);
  expect(dash.events).toHaveLength(1);
  expect(dash.events[0]).toMatchObject({ id, run: "run-1", target: "react_frontend", pipeline: "1", job: "77", step: "triage", type: "step_start" });
  expect(dash.events[0].data).toMatchObject({ prompt: "echo [secret]", deep: [{ x: ["[secret]"] }] });
  expect(JSON.parse(readFileSync(file, "utf8").trim())).toEqual(dash.events[0]);
});

test("a 1 MB result is cut to MAX_FIELD", () => {
  const { w, dash } = world("run-1");
  emit(w.ctx, "tool_call", { name: "bash", input: "x", result: "y".repeat(1_000_000), ms: 1, ok: true });
  expect(eventsOfType(dash.events, "tool_call")[0].data.result.length).toBe(MAX_FIELD);
});

test("a run with no ID sends no event and writes no file", () => {
  const { w, dash, file } = world();
  expect(emit(w.ctx, "run_start", {})).toBeUndefined();
  expect(dash.events).toEqual([]);
  expect(existsSync(file)).toBe(false);
});

test("a failed events.jsonl write does not throw: the event still goes to the dashboard, with one warning", () => {
  const { w, dash } = world("run-1");
  const notADir = join(mkdtempSync(join(tmpdir(), "emit-")), "file");
  writeFileSync(notADir, "");
  w.ctx.dir = join(notADir, "target"); // the run dir is a file, so the write fails
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const id = emit(w.ctx, "run_start", {});
  expect(dash.events.map((e) => e.id)).toEqual([id]);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0][0])).toContain(`run_start ${id}`);
  warn.mockRestore();
});
