import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { BROWSER_ENDPOINT, playwrightVersion, withBrowserServer } from "./browser-server";

const clone = (version?: unknown, pkg = "playwright-core") => {
  const dir = mkdtempSync(join(tmpdir(), "bs-"));
  if (version !== undefined) {
    mkdirSync(join(dir, "node_modules", pkg), { recursive: true });
    writeFileSync(join(dir, "node_modules", pkg, "package.json"), JSON.stringify({ version }));
  }
  return dir;
};

test("playwrightVersion takes only a plain x.y.z from the clone", () => {
  expect(playwrightVersion(clone("1.64.1"))).toBe("1.64.1");
  expect(playwrightVersion(clone("1.64.1; rm -rf /"))).toBeUndefined();
  expect(playwrightVersion(clone("latest"))).toBeUndefined();
  expect(playwrightVersion(clone(7))).toBeUndefined();
  expect(playwrightVersion(clone())).toBeUndefined();
});

test("a pnpm clone with only @playwright/test at the top still gets its Playwright version", () => {
  expect(playwrightVersion(clone("1.64.1", "@playwright/test"))).toBe("1.64.1");
});

test("no server off macOS, without Playwright in the clone, or without a clone", async () => {
  expect(await withBrowserServer(clone("1.64.1"), process.env, async (v) => v, "linux")).toEqual({});
  expect(await withBrowserServer(clone(), process.env, async (v) => v, "darwin")).toEqual({});
  expect(await withBrowserServer("", process.env, async (v) => v, "darwin")).toEqual({});
});

// Downloads Playwright and Chromium the first time. Run with FACTORY_BROWSER_TEST=1 on a Mac.
test.runIf(process.platform === "darwin" && process.env.FACTORY_BROWSER_TEST)("the server loads localhost pages and refuses the internet", async () => {
  const { createServer } = await import("node:http");
  const site = createServer((_, res) => res.end("<h1>local</h1>")).listen(0, "127.0.0.1");
  await new Promise((r) => site.once("listening", r));
  const port = (site.address() as { port: number }).port;
  const results = await withBrowserServer(clone("1.62.1"), process.env, async (vars) => {
    expect(vars[BROWSER_ENDPOINT]).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/);
    // @ts-ignore the dashboard's Playwright, also 1.62.1
    const { chromium } = await import("../dashboard/node_modules/@playwright/test/index.js");
    const browser = await chromium.connect(vars[BROWSER_ENDPOINT]);
    const go = async (url: string) => {
      const page = await (await browser.newContext()).newPage();
      try {
        return (await page.goto(url, { timeout: 8000 }))?.status();
      } catch (e) {
        return (e as Error).message.split("\n")[0];
      } finally {
        await page.context().close();
      }
    };
    const r = [await go(`http://127.0.0.1:${port}/`), await go("https://example.com/"), await go(`http://127.0.0.1:${port}/`)];
    await browser.close();
    return r;
  });
  site.close();
  expect(results[0]).toBe(200);
  expect(results[1]).toContain("ERR_ACCESS_DENIED");
  expect(results[2]).toBe(200); // a second context after one closed: what single-process Chromium cannot do
}, 600_000);
