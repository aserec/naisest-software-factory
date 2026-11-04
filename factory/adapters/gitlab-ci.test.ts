import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { GitLab } from "../gitlab";
import { NotFactoryRunError } from "../seams";
import { GITLAB_URL } from "../gitlab";
import { extractRun, makeGitLabCi } from "./gitlab-ci";
import { zip } from "./test-zip";

const tmp = () => mkdtempSync(join(tmpdir(), "ci-"));
// An env with a secret dir. Each File variable is a path inside it.
function setup(o: Record<string, string> = {}, files: Record<string, string> = { gl: "glpat-x", teams: "https://t" }) {
  const dir = tmp();
  for (const [name, v] of Object.entries(files)) writeFileSync(join(dir, name), `${v}\n`);
  const env = { CI_SERVER_URL: GITLAB_URL, CI_PROJECT_ID: "3", FACTORY_PIPELINE: "build", FACTORY_TARGET: "react_frontend", FACTORY_GITLAB_TOKEN: join(dir, "gl"), TEAMS_WEBHOOK_URL: join(dir, "teams"), ...o };
  return { dir, env };
}
const ci = (o: Record<string, string> = {}) => {
  const { dir, env } = setup(o);
  return makeGitLabCi(env, dir);
};

describe("secret files", () => {
  test("are read into memory and deleted, and each secret is handed out once", () => {
    const { dir, env } = setup({ FACTORY_TRIGGER_TOKEN: "x" }, { gl: "glpat-x", teams: "https://t", trig: "tt" });
    const runner = makeGitLabCi({ ...env, FACTORY_TRIGGER_TOKEN: join(dir, "trig") }, dir);
    for (const k of ["gl", "teams", "trig"]) expect(existsSync(join(dir, k))).toBe(false);
    expect(runner.secret("FACTORY_GITLAB_TOKEN")).toBe("glpat-x");
    expect(runner.secret("FACTORY_GITLAB_TOKEN")).toBeUndefined();
    expect(runner.secret("TEAMS_WEBHOOK_URL")).toBe("https://t");
    expect(runner.secret("FACTORY_TRIGGER_TOKEN")).toBeUndefined(); // only the adapter uses it
  });
  test("a raw value instead of a File variable is refused and never printed", () => {
    const { dir, env } = setup();
    const err = (() => { try { makeGitLabCi({ ...env, FACTORY_GITLAB_TOKEN: "glpat-raw-value" }, dir); } catch (e) { return String(e); } })();
    expect(err).toContain("must be a File type CI variable");
    expect(err).not.toContain("glpat-raw-value");
  });
  test("are read and deleted only inside the runner's temp dir", () => {
    const { dir, env } = setup();
    const other = tmp();
    const secret = join(other, "keep");
    writeFileSync(secret, "do not delete");
    expect(() => makeGitLabCi({ ...env, FACTORY_GITLAB_TOKEN: secret }, dir)).toThrow(/FACTORY_GITLAB_TOKEN/);
    expect(() => makeGitLabCi({ ...env, FACTORY_GITLAB_TOKEN: `${dir}/../${other.split("/").at(-1)}/keep` }, dir)).toThrow(/FACTORY_GITLAB_TOKEN/);
    expect(existsSync(secret)).toBe(true);
  });
});

test("only the fixed GitLab host and a numeric project id are accepted", () => {
  expect(() => ci()).not.toThrow();
  expect(() => ci({ CI_SERVER_URL: "https://evil.example" })).toThrow(/CI_SERVER_URL/);
  expect(() => ci({ CI_SERVER_URL: `${GITLAB_URL}.evil.example` })).toThrow(/CI_SERVER_URL/);
  expect(() => ci({ CI_PROJECT_ID: "3/../9" })).toThrow(/CI_PROJECT_ID/);
  expect(() => ci({ CI_PROJECT_ID: "" })).toThrow(/CI_PROJECT_ID/);
});

// Trigger callers can set any variable. Each FACTORY_* value must match its pattern, or the run does not start.
test("FACTORY_* values that do not match their pattern are refused", () => {
  const good = { FACTORY_PIPELINE: "finish", FACTORY_WORK_ITEM_IID: "8", FACTORY_MR_IID: "5", FACTORY_BUILD_PIPELINE_ID: "41", FACTORY_SKIP_APPLY: "1" };
  expect(ci(good).vars).toMatchObject({ ticket: "8", change: "5", buildRun: "41", skipApply: true });
  expect(() => ci({ FACTORY_WORK_ITEM_IID: "" })).not.toThrow(); // a webhook trigger has no iid
  expect(() => ci({ FACTORY_PIPELINE: "deploy" })).toThrow(/FACTORY_PIPELINE/);
  expect(() => ci({ FACTORY_PIPELINE: "" })).toThrow(/FACTORY_PIPELINE/);
  for (const k of ["FACTORY_WORK_ITEM_IID", "FACTORY_MR_IID", "FACTORY_BUILD_PIPELINE_ID"]) {
    expect(() => ci({ ...good, [k]: "8; rm -rf /" })).toThrow(new RegExp(k));
    expect(() => ci({ ...good, [k]: "1e3" })).toThrow(new RegExp(k));
  }
  expect(() => ci({ FACTORY_SKIP_APPLY: "yes" })).toThrow(/FACTORY_SKIP_APPLY/);
  expect(() => ci({ FACTORY_PIPELINE: "", FACTORY_SCHEDULE: "poll" })).not.toThrow();
  expect(() => ci({ FACTORY_PIPELINE: "", FACTORY_SCHEDULE: "retry" })).not.toThrow();
  expect(() => ci({ FACTORY_PIPELINE: "", FACTORY_SCHEDULE: "watch" })).not.toThrow();
  expect(() => ci({ FACTORY_PIPELINE: "", FACTORY_SCHEDULE: "improve" })).not.toThrow();
  expect(() => ci({ FACTORY_PIPELINE: "dispatch" })).not.toThrow();
  expect(() => ci({ FACTORY_PIPELINE: "deploy" })).toThrow(/FACTORY_PIPELINE/);
  expect(() => ci({ FACTORY_PIPELINE: "", FACTORY_SCHEDULE: "deploy" })).toThrow(/FACTORY_SCHEDULE/);
  expect(() => ci({ FACTORY_SCHEDULE: "poll" })).toThrow(/FACTORY_PIPELINE/);
});

test("vars map the trigger variables, the run and the payload file", () => {
  const { dir, env } = setup({ CI_PIPELINE_ID: "77", CI_PIPELINE_URL: "https://gl/p/77" });
  writeFileSync(join(dir, "payload.json"), JSON.stringify({ object_kind: "issue" }));
  const { vars } = makeGitLabCi({ ...env, TRIGGER_PAYLOAD: join(dir, "payload.json") }, dir);
  expect(vars).toEqual({ ticket: undefined, change: undefined, skipApply: false, buildRun: undefined, run: "77", runUrl: "https://gl/p/77", payload: { object_kind: "issue" } });
});

describe("start", () => {
  let posted: { url: string; body: URLSearchParams }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    posted.push({ url, body: init.body as URLSearchParams });
    return new Response(JSON.stringify({ id: 77, web_url: "https://gitlab.example/p/-/pipelines/77" }), { status: url.includes("fail") ? 500 : 200 });
  }) as unknown as typeof fetch;
  const runner = (o: Record<string, string> = {}) => {
    const { dir, env } = setup({ CI_COMMIT_REF_NAME: "main", FACTORY_TRIGGER_TOKEN: "", ...o }, { gl: "glpat-x", teams: "https://t", trig: "trigger-token" });
    return makeGitLabCi({ ...env, FACTORY_TRIGGER_TOKEN: join(dir, "trig") }, dir, fetchFn);
  };

  test("maps the run to trigger variables as the bot, with the token in the body only", async () => {
    posted = [];
    expect(await runner().start({ kind: "finish", ticket: "8", change: "5", buildRun: "41", skipApply: true })).toBe("https://gitlab.example/p/-/pipelines/77");
    expect(posted[0].url).toBe(`${GITLAB_URL}/api/v4/projects/3/trigger/pipeline`);
    expect(Object.fromEntries(posted[0].body)).toEqual({
      token: "trigger-token", ref: "main", "variables[FACTORY_PIPELINE]": "finish", "variables[FACTORY_TARGET]": "react_frontend",
      "variables[FACTORY_WORK_ITEM_IID]": "8", "variables[FACTORY_MR_IID]": "5", "variables[FACTORY_BUILD_PIPELINE_ID]": "41", "variables[FACTORY_SKIP_APPLY]": "1",
    });
  });
  test("leaves out what the run does not have", async () => {
    posted = [];
    await runner().start({ kind: "build", ticket: "8" });
    expect([...posted[0].body.keys()].sort()).toEqual(["ref", "token", "variables[FACTORY_PIPELINE]", "variables[FACTORY_TARGET]", "variables[FACTORY_WORK_ITEM_IID]"]);
  });
  test("a started pipeline whose reply does not parse gives an empty link, not a throw", async () => {
    const badBody = ((async () => new Response("not json", { status: 201 })) as unknown) as typeof fetch;
    const { dir, env } = setup({ CI_COMMIT_REF_NAME: "main" }, { gl: "glpat-x", teams: "https://t", trig: "trigger-token" });
    expect(await makeGitLabCi({ ...env, FACTORY_TRIGGER_TOKEN: join(dir, "trig") }, dir, badBody).start({ kind: "build", ticket: "8" })).toBe("");
  });
  test("fails without a trigger token, and a failed call names the status but not the token", async () => {
    await expect(ci({ CI_COMMIT_REF_NAME: "main" }).start({ kind: "build", ticket: "8" })).rejects.toThrow(/FACTORY_TRIGGER_TOKEN/);
    const failing = ((async () => new Response("{}", { status: 500 })) as unknown) as typeof fetch;
    const { dir, env } = setup({ CI_COMMIT_REF_NAME: "main" }, { gl: "glpat-x", teams: "https://t", trig: "trigger-token" });
    const err = await makeGitLabCi({ ...env, FACTORY_TRIGGER_TOKEN: join(dir, "trig") }, dir, failing).start({ kind: "build", ticket: "8" }).catch((e) => e);
    expect(err.message).toContain("500");
    expect(err.message).not.toContain("trigger-token");
  });
});

describe("buildRecord", () => {
  const pipeline = { id: 41, source: "trigger", ref: "main", user: { id: 1 } };
  const routes = (p: object) => (async (url: string) => {
    const path = url.replace(`${GITLAB_URL}/api/v4`, "");
    const body =
      path === "/projects/3/pipelines/41" ? p :
      path === "/projects/3" ? { id: 3, default_branch: "main" } :
      path === "/user" ? { id: 1 } :
      path.startsWith("/projects/3/pipelines/41/jobs") ? [{ id: 10, name: "decision", status: "success" }, { id: 12, name: "decision", status: "success" }, { id: 11, name: "risk-check", status: "success" }] :
      path === "/projects/3/jobs/12/artifacts/run/record.json" ? { workItem: "newest" } :
      path === "/projects/3/jobs/10/artifacts/run/record.json" ? { workItem: "older" } : undefined;
    return new Response(JSON.stringify(body ?? {}), { status: body ? 200 : 404 });
  }) as unknown as typeof fetch;
  const runner = (p: object) => {
    const { dir, env } = setup();
    return makeGitLabCi(env, dir, routes(p));
  };

  test("reads the newest decision job of a bot-triggered run on the default branch", async () => {
    expect(await runner(pipeline).buildRecord("41")).toEqual({ workItem: "newest" });
  });
  test.each([
    ["not started by a trigger", { ...pipeline, source: "push" }],
    ["not on the default branch", { ...pipeline, ref: "evil" }],
    ["not started by the bot", { ...pipeline, user: { id: 9 } }],
  ])("rejects a run %s", async (_name, p) => {
    await expect(runner(p).buildRecord("41")).rejects.toBeInstanceOf(NotFactoryRunError);
    await expect(runner(p).restoreRun("41")).rejects.toBeInstanceOf(NotFactoryRunError);
  });
});

test("extractRun restores run/ without the stop file and writes nothing outside run/", async () => {
  const base = tmp();
  const cwd = join(base, "job");
  mkdirSync(cwd);
  await extractRun(zip({ "run/record.json": "{}", "run/stop": "prepare-patch", "run/../x": "evil", "../y": "evil", "z": "evil" }), cwd);
  expect(readFileSync(join(cwd, "run/record.json"), "utf8")).toBe("{}");
  expect(existsSync(join(cwd, "run/stop"))).toBe(false);
  for (const p of [join(cwd, "x"), join(base, "y"), join(cwd, "z")]) expect(existsSync(p)).toBe(false);
});
