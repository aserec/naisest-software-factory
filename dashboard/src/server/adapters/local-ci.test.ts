import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ciContract } from "../contracts/ci.contract";
import { NotSetUp } from "../not-set-up";
import { makeLocalCi } from "./local-ci";

beforeEach(() => vi.stubEnv("FACTORY_DASHBOARD_TOKEN", "dash"));
afterEach(() => vi.unstubAllEnvs());

// A fake worker: it records the posts it gets, with the bearer, and answers 404 for a target named evil.
function fakeWorker() {
  const calls: { url: string; auth: string }[] = [];
  let refusing = false;
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: (init.headers as Record<string, string>).Authorization });
    return new Response(null, { status: refusing || url.includes("evil") ? 404 : 204 });
  }) as unknown as typeof fetch;
  return { fn, calls, refuse: () => void (refusing = true) };
}

ciContract("local", () => {
  const w = fakeWorker();
  const posted = (re: RegExp) => w.calls.flatMap((c) => re.exec(c.url)?.[1] ?? []);
  return { ci: makeLocalCi(w.fn), cancelled: () => posted(/\/runs\/(.+)\/cancel$/), dispatched: () => posted(/\/dispatch\/(.+)$/), refuse: w.refuse };
}, { listsJobs: false });

it("cancel and dispatch post to the worker with the dashboard token; a refusal throws", async () => {
  const w = fakeWorker();
  const ci = makeLocalCi(w.fn);
  await ci.cancel("7");
  await ci.startDispatch("react_frontend");
  expect(w.calls).toEqual([{ url: "http://worker:8080/runs/7/cancel", auth: "Bearer dash" }, { url: "http://worker:8080/dispatch/react_frontend", auth: "Bearer dash" }]);
  await expect(ci.startDispatch("evil")).rejects.toThrow(/404/);
});

it("the worker has no job list or job log, so both say not set up", async () => {
  const ci = makeLocalCi(fakeWorker().fn);
  await expect(ci.runningJobs()).rejects.toBeInstanceOf(NotSetUp);
  await expect(ci.jobLog("1")).rejects.toBeInstanceOf(NotSetUp);
});
