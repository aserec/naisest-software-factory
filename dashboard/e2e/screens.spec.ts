import { expect, test } from "@playwright/test";
import { COOKIE, RUN, sessionToken } from "./seed";

test("open the board, a run, the prepare-patch step and a tool call", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: COOKIE, value: await sessionToken(), url: baseURL! }]);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Factory" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /running/ })).toBeVisible();
  await page.getByRole("link", { name: "Fix login" }).click();

  await expect(page).toHaveURL(new RegExp(`/runs/${RUN}$`));
  const lane = page.getByRole("button", { name: /prepare-patch/ });
  await expect(lane).toBeVisible();
  await expect(page.locator("summary", { hasText: "Edit" })).toBeHidden();
  await lane.click();
  await expect(page.locator("summary", { hasText: "Edit" })).toBeVisible();

  await page.getByRole("button", { name: "Details" }).click();
  await expect(page.getByText("Fix the login bug")).toBeVisible();
  await page.getByRole("tab", { name: "Job log" }).click();
  await expect(page.getByText("log line from the stub")).toBeVisible();
});

test("a page without a session goes to sign-in, an API route answers 401", async ({ page, request }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in/);
  expect((await request.get("/api/events?run=x")).status()).toBe(401);
});
