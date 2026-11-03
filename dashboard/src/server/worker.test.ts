import { afterEach, expect, test } from "vitest";
import { getCi, getGitLab } from "./gitlab-instance";
import { makeWorker } from "./worker";

afterEach(() => { delete process.env.FACTORY_CI; });

test("with FACTORY_CI=local the loop's CI is the worker; otherwise GitLab", () => {
  expect(getCi()).toBe(getGitLab());
  process.env.FACTORY_CI = "local";
  expect(getCi()).not.toBe(getGitLab());
  expect(getCi().importEvents).toBeDefined();
});

test("cancel and dispatch post to the worker with the dashboard token; a refusal throws", async () => {
  process.env.FACTORY_DASHBOARD_TOKEN = "dash";
  const calls: { url: string; auth: string }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: (init.headers as Record<string, string>).Authorization });
    return new Response(null, { status: url.includes("evil") ? 404 : 204 });
  }) as unknown as typeof fetch;
  const w = makeWorker(fetchFn);
  await w.cancelPipeline("7");
  await w.startDispatch("react_frontend");
  expect(calls).toEqual([{ url: "http://worker:8080/runs/7/cancel", auth: "Bearer dash" }, { url: "http://worker:8080/dispatch/react_frontend", auth: "Bearer dash" }]);
  await expect(w.startDispatch("evil")).rejects.toThrow(/404/);
});
