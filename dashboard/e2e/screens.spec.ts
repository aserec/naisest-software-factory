import { expect, test } from "@playwright/test";
import { APPROVE_RUN, COOKIE, MR_URL, RUN, sessionToken } from "./seed";

test("open the board, a run, and the prepare-patch step in the side panel", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: COOKIE, value: await sessionToken(), url: baseURL! }]);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Board" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /running/i })).toBeVisible();
  await page.getByRole("link", { name: "Fix login" }).click();

  await expect(page).toHaveURL(new RegExp(`/runs/${RUN}$`));
  const lane = page.getByRole("button", { name: /prepare-patch/ });
  await expect(lane).toBeVisible();
  await expect(page.getByRole("dialog")).toBeHidden();
  await lane.click();
  const panel = page.getByRole("dialog");
  await expect(panel).toBeVisible();
  await expect(page).toHaveURL(/\?step=/);
  await expect(panel.getByText("Fix the login bug")).toBeVisible();
  await expect(panel.locator("summary", { hasText: "Edit" })).toBeVisible();
  await expect(panel.getByText("log line from the stub")).toBeVisible();
  await panel.getByRole("button", { name: "Close" }).click();
  await expect(panel).toBeHidden();
});

test("a run that needs approval links its merge request and shows both risks; a running one has no link", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: COOKIE, value: await sessionToken(), url: baseURL! }]);
  await page.goto(`/runs/${APPROVE_RUN}`);
  await expect(page.getByRole("link", { name: "Review and merge in GitLab" })).toHaveAttribute("href", MR_URL);
  await expect(page.getByText("Medium risk")).toBeVisible();
  await expect(page.getByText("Merge risk 6/10")).toBeVisible();
  await expect(page.getByText("Waits for a person, because diff_risk 6 is above 4.")).toBeVisible();
  await page.goto(`/runs/${RUN}`);
  await expect(page.getByRole("heading", { name: "demo #7" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Review and merge in GitLab" })).toHaveCount(0);
});

test("a page without a session goes to sign-in, an API route answers 401", async ({ page, request }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in/);
  expect((await request.get("/api/events?run=x")).status()).toBe(401);
});
