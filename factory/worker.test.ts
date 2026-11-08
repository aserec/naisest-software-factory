import { loadSeams } from "./config";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { QueuedRun } from "./adapters/local-ci";
import { FACTORY_ROOT } from "./repo";
import { BUILD_STEPS } from "./steps/run";
import { handler, improveDue, machineHost, nextId, runImprove, runOne, runShort, stepEnv, takeQueue, targetLock, tickTarget, type Exec, type Live } from "./worker";

const tmp = () => mkdtempSync(join(tmpdir(), "worker-"));
const base = { GL_TOKEN: "glpat-x", FACTORY_DASHBOARD_TOKEN: "dash", TENSORX_API_KEY: "tx" };

// A fake docker: `start -a` ends each step with codes[step] (0 by default). Copying run/ out makes out/run;
// decision's queue copy leaves a finish request, as decision's start() would.
function fakeDocker(codes: Record<string, number> = {}) {
  const calls: string[][] = [];
  const envs: (Record<string, string> | undefined)[] = [];
  const exec: Exec = async (_cmd, args, env) => {
    calls.push(args);
    envs.push(env);
    if (args[0] === "start") return { code: codes[args[2].split("-").slice(2).join("-")] ?? 0, out: "" };
    if (args[0] === "cp" && args[1].endsWith(`:${FACTORY_ROOT}/run`)) mkdirSync(join(args[2], "run"), { recursive: true });
    if (args[0] === "cp" && args[1].includes("-decision:")) writeFileSync(join(args[2], "1-a.json"), JSON.stringify({ kind: "finish", target: "react_frontend", ticket: "8", buildRun: "7" }));
    return { code: 0, out: "" };
  };
  return { calls, envs, exec, started: () => calls.filter((a) => a[0] === "start").map((a) => a[2].split("-").slice(2).join("-")) };
}
const run = (d: ReturnType<typeof fakeDocker>, runs: string, queue: string, q: QueuedRun = { kind: "build", target: "react_frontend", ticket: "8" }) =>
  runOne(q, "7", { exec: d.exec, base, open: machineHost(), image: "factory-worker", lock: targetLock(), runsDir: runs, queueDir: queue });

test("a build run starts each step in its own container, saves run/ and marks it ok after decision, then queues what it asked", async () => {
  const d = fakeDocker(), runs = tmp(), queue = tmp();
  await run(d, runs, queue);
  expect(d.started()).toEqual(BUILD_STEPS);
  const create = d.calls.find((a) => a[0] === "create" && a.includes("factory/steps/triage.ts"))!;
  expect(create).toContain(`factory-run-7:${FACTORY_ROOT}/run`);
  expect(create).toContain(`FACTORY_GITLAB_TOKEN=${FACTORY_ROOT}.tmp/FACTORY_GITLAB_TOKEN`); // a path, never the token
  expect(create.join(" ")).not.toContain("glpat-x");
  // A provider key goes by name only: its value is in docker's env, never on the command line.
  expect(create).toContain("TENSORX_API_KEY");
  expect(create.join(" ")).not.toContain("TENSORX_API_KEY=");
  expect(d.envs[d.calls.indexOf(create)]).toMatchObject({ TENSORX_API_KEY: "tx" });
  expect(existsSync(join(runs, "7", "ok"))).toBe(true);
  expect(readdirSync(queue)).toEqual(["1-a.json"]);
  expect(d.calls.at(-1)).toEqual(["volume", "rm", "-f", "factory-run-7", "factory-ref-7"]);
});

test("a failed step ends the run, and a run whose decision did not pass gets no ok", async () => {
  const d = fakeDocker({ "code-review": 1 }), runs = tmp();
  await run(d, runs, tmp());
  expect(d.started()).toEqual(["event", "triage", "prepare-patch", "code-review"]);
  expect(existsSync(join(runs, "7", "ok"))).toBe(false);
});

test("a finish run mounts its build run read-only, and only one the worker marked ok", async () => {
  const runs = tmp();
  const finish = { kind: "finish" as const, target: "react_frontend", ticket: "8", change: "3", buildRun: "4" };
  await expect(run(fakeDocker(), runs, tmp(), finish)).rejects.toThrow(/not a finished build run/);
  mkdirSync(join(runs, "4"));
  writeFileSync(join(runs, "4", "ok"), "");
  const d = fakeDocker();
  await run(d, runs, tmp(), finish);
  expect(d.started()).toEqual(["apply", "verify", "result-saved"]);
  expect(d.calls.find((a) => a[0] === "create" && a.includes("factory/steps/apply.ts"))).toContain(`factory-ref-7:${FACTORY_ROOT}.runs:ro`);
});

test("a queued run with a bad value starts nothing", async () => {
  const d = fakeDocker();
  await expect(run(d, tmp(), tmp(), { kind: "build", target: "react_frontend", ticket: "8; rm -rf /" })).rejects.toThrow(/FACTORY_WORK_ITEM_IID/);
  expect(d.calls).toEqual([]);
});

test("the event steps of one target run one at a time", async () => {
  const lock = targetLock();
  const order: string[] = [];
  const job = (n: string) => lock("t", async () => { order.push(`${n} in`); await new Promise((r) => setTimeout(r, 5)); order.push(`${n} out`); return true; });
  await Promise.all([job("a"), job("b")]);
  expect(order).toEqual(["a in", "a out", "b in", "b out"]);
});

test("takeQueue takes valid runs oldest first and moves a bad file aside; nextId counts up", () => {
  const q = tmp();
  writeFileSync(join(q, "2.json"), JSON.stringify({ kind: "finish", target: "t", ticket: "9" }));
  writeFileSync(join(q, "1.json"), JSON.stringify({ kind: "build", target: "t", ticket: "8" }));
  writeFileSync(join(q, "3.json"), JSON.stringify({ kind: "deploy", target: "t" }));
  expect(takeQueue(q).map((r) => r.ticket)).toEqual(["8", "9"]);
  expect(readdirSync(q)).toEqual(["3.json.bad"]);
  const runs = tmp();
  expect([nextId(runs), nextId(runs)]).toEqual(["1", "2"]);
});

test("a cancel kills the running step's container and starts no next step", async () => {
  const d = fakeDocker(), live: Live = { cancelled: false };
  const exec: Exec = async (cmd, args, env) => {
    if (args[0] === "start" && args[2].endsWith("-triage")) { live.cancelled = true; await live.kill?.(); return { code: 137, out: "" }; }
    return d.exec(cmd, args, env);
  };
  await runOne({ kind: "build", target: "react_frontend", ticket: "8" }, "7", { exec, base, open: machineHost(), image: "factory-worker", lock: targetLock(), runsDir: tmp(), queueDir: tmp(), live });
  expect(d.calls.filter((a) => a[0] === "start").map((a) => a[2])).toEqual(["factory-7-event"]);
  expect(d.calls).toContainEqual(["kill", "factory-7-triage"]);
});

test("the dashboard's calls need its token, and only cancel and dispatch are served", async () => {
  const seen: string[] = [];
  const h = handler("dash", { cancel: async (r) => (seen.push(`cancel ${r}`), r === "7"), dispatch: (t) => (seen.push(`dispatch ${t}`), true) });
  const post = async (url: string, token = "dash", method = "POST") => {
    let code = 0;
    const res = { writeHead: (c: number) => ((code = c), { end: () => {} }) } as never;
    await h({ url, method, headers: { authorization: `Bearer ${token}` } }, res);
    return code;
  };
  expect(await post("/runs/7/cancel", "wrong")).toBe(401);
  expect(await post("/runs/7/cancel")).toBe(204);
  expect(await post("/runs/8/cancel")).toBe(404);
  expect(await post("/runs/7/cancel", "dash", "GET")).toBe(404);
  expect(await post("/dispatch/react_frontend")).toBe(202);
  expect(await post("/dispatch/../x")).toBe(404);
  expect(seen).toEqual(["cancel 7", "cancel 8", "dispatch react_frontend"]);
});

test("the watcher gets the person's source only when one is given", () => {
  expect(stepEnv(base, { schedule: "watch", target: "react_frontend", source: "web" }).CI_PIPELINE_SOURCE).toBe("web");
  expect(stepEnv(base, { schedule: "poll", target: "react_frontend" }).CI_PIPELINE_SOURCE).toBeUndefined();
});

test("a step gets the key of every provider in seams.yml, and no other variable", () => {
  const seams = { ...loadSeams(), providers: { other: { name: "other", api: "openai" as const, keyEnv: "OTHER_API_KEY", models: {} } } };
  const e = stepEnv({ ...base, OTHER_API_KEY: "o", CELERIS_API_KEY: "b", UNRELATED: "u" }, { schedule: "poll", target: "react_frontend" }, seams);
  expect(e).toMatchObject({ OTHER_API_KEY: "o", CELERIS_API_KEY: "b" });
  expect(e.TENSORX_API_KEY).toBeUndefined();
  expect(e.UNRELATED).toBeUndefined();
});

test("improveDue is true once a week per target and writes the time first", () => {
  const dir = tmp(), day = 86_400_000, t0 = new Date("2026-11-02T06:00:00Z");
  expect(improveDue("t", t0, dir)).toBe(true);
  expect(improveDue("t", new Date(t0.getTime() + 6 * day), dir)).toBe(false);
  expect(improveDue("t", new Date(t0.getTime() + 7 * day), dir)).toBe(true);
  expect(improveDue("t", new Date(t0.getTime() + 8 * day), dir)).toBe(false); // the time moved to day 7
  expect(improveDue("other", t0, dir)).toBe(true); // a second target has its own file
  expect(improveDue("t", new Date(t0.getTime() + 14 * day), dir)).toBe(true);
});

test("an improve step gets FACTORY_SCHEDULE=improve", () => {
  expect(stepEnv(base, { schedule: "improve", target: "react_frontend" })).toMatchObject({ FACTORY_SCHEDULE: "improve", FACTORY_PIPELINE: "" });
});

// The improve step clones into <cwd>/run/target, so each job needs a folder of its own: one shared folder would hand a
// later job (or another target) the first clone, and two targets would race on it.
test("each improve job runs in a new working folder that is gone afterwards", async () => {
  const secrets = `${FACTORY_ROOT}.tmp`, made = !existsSync(secrets);
  mkdirSync(secrets, { recursive: true });
  const seen: { target: string; cwd: string; script: string; existed: boolean; schedule: string }[] = [];
  const exec: Exec = async (_cmd, args, env, cwd) => {
    mkdirSync(join(cwd!, "run", "target"), { recursive: true }); // what the clone does
    seen.push({ target: env!.FACTORY_TARGET, cwd: cwd!, script: args.at(-1)!, existed: existsSync(cwd!), schedule: env!.FACTORY_SCHEDULE });
    if (seen.length === 3) throw new Error("exec failed");
    return { code: 0, out: "" };
  };
  try {
    await runImprove(exec, base, "a");
    await runImprove(exec, base, "a");
    await expect(runImprove(exec, base, "b")).rejects.toThrow("exec failed");
    expect(new Set(seen.map((s) => s.cwd)).size).toBe(3);
    for (const s of seen) {
      expect(s.existed).toBe(true);
      expect(existsSync(s.cwd)).toBe(false); // removed, also when the step threw
      expect(s.script).toBe(join(FACTORY_ROOT, "factory/steps/improve.ts")); // absolute, since cwd is not the factory root
      expect(s.schedule).toBe("improve");
    }
  } finally {
    if (made) rmSync(secrets, { recursive: true, force: true });
  }
});

test("each tick polls; the hourly tick also retries, watches and starts a due improve job once a week", async () => {
  const secrets = `${FACTORY_ROOT}.tmp`, made = !existsSync(secrets);
  mkdirSync(secrets, { recursive: true });
  const runsDir = mkdtempSync(join(tmpdir(), "tick-"));
  const steps: string[] = [];
  const exec: Exec = async (_cmd, args) => (steps.push(args.at(-1)!.replace(/^.*\/|\.ts$/g, "")), { code: 0, out: "" });
  const improved: string[] = [];
  const o = { watch: true, improve: (t: string) => void improved.push(t), now: new Date("2026-11-04T12:00:00Z"), runsDir };
  try {
    await tickTarget(exec, base, "a", 1, o);
    expect(steps).toEqual(["poll"]);
    await tickTarget(exec, base, "a", 60, o);
    expect(steps).toEqual(["poll", "poll", "resume-waiting", "watcher"]);
    expect(improved).toEqual(["a"]);
    await tickTarget(exec, base, "a", 120, { ...o, watch: false });
    expect(steps.slice(4)).toEqual(["poll", "resume-waiting"]);
    expect(improved).toEqual(["a"]); // not due again within the week
    // A failing target is logged, and the tick goes on to the next target.
    const failing: Exec = async () => { throw new Error("docker down"); };
    await expect(tickTarget(failing, base, "a", 1, o)).resolves.toBeUndefined();
  } finally {
    if (made) rmSync(secrets, { recursive: true, force: true });
  }
});

// The fix step gets its plan in the env, may have no target (a plan for the factory repo), and its exit code comes back.
test("runShort fix passes the plan, accepts an empty target and returns the exit code", async () => {
  mkdirSync(`${FACTORY_ROOT}.tmp`, { recursive: true });
  let env: Record<string, string> = {};
  const exec: Exec = async (_cmd, _args, e) => { env = e!; return { code: 3, out: "" }; };
  expect(await runShort(exec, base, "fix", "", undefined, tmpdir(), { FACTORY_PLAN: '{"id":"x"}' })).toBe(3);
  expect(env).toMatchObject({ FACTORY_PIPELINE: "fix", FACTORY_TARGET: "", FACTORY_PLAN: '{"id":"x"}' });
  expect(() => stepEnv(base, { schedule: "poll", target: "" })).toThrow(); // other steps still need a target
});
