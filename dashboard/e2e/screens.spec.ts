import { expect, test } from "@playwright/test";
import { APPROVE_RUN, COOKIE, MR_URL, RUN, sessionToken } from "./seed";

test("open the board, a run, and the prepare-patch step in the side panel", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: COOKIE, value: await sessionToken(), url: baseURL! }]);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Board" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /running/i })).toBeVisible();
  await page.getByRole("link", { name: "Fix login" }).click();

  await expect(page).toHaveURL(new RegExp(`/runs/${RUN}$`));
  const lane = page.getByRole("button", { name: /Implement/ });
  await expect(lane).toBeVisible();
  await expect(page.getByRole("dialog")).toBeHidden();
  await lane.click();
  const panel = page.getByRole("dialog");
  await expect(panel).toBeVisible();
  await expect(page).toHaveURL(/\?step=/);
  await expect(panel.getByRole("heading", { level: 2 })).toBeFocused();
  await expect(panel.getByText("Fix the login bug")).toBeVisible();
  await expect(panel.locator("summary", { hasText: "Edit" })).toBeVisible();
  await expect(panel.getByText("log line from the stub")).toBeVisible();
  // From 1024px the page moves aside: the title row, the figures and the steps all end left of the panel.
  await page.waitForTimeout(400); // the 300ms slide and padding transition
  const edge = (await panel.boundingBox())!.x;
  for (const box of [page.getByRole("heading", { level: 1 }), page.getByText("Risk", { exact: true }), page.getByRole("button", { name: /Implement/ }), page.locator("main p").first(), page.getByRole("button", { name: "Stop" })])
    expect(await box.evaluate((e) => e.getBoundingClientRect().right)).toBeLessThanOrEqual(edge);
  await panel.getByRole("button", { name: "Close" }).click();
  await expect(panel).toBeHidden();
  await expect(lane).toBeFocused();
});

test("a run that needs approval links its merge request and shows both risks; a running one has no link", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: COOKIE, value: await sessionToken(), url: baseURL! }]);
  await page.goto(`/runs/${APPROVE_RUN}`);
  await expect(page.getByRole("link", { name: "Open PR" })).toHaveAttribute("href", MR_URL);
  await expect(page.getByText("Triage risk medium")).toBeVisible();
  await expect(page.getByText("Merge risk 6/10, limit 4")).toBeVisible();
  await expect(page.getByText("Waits for you because")).toBeVisible();
  await expect(page.getByText("Merge risk 6 is above the limit of 4")).toBeVisible();
  await page.goto(`/runs/${RUN}`);
  await expect(page.getByRole("heading", { name: "Fix login" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open PR" })).toHaveCount(0);
});

test("a page without a session goes to sign-in, an API route answers 401", async ({ page, request }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in/);
  expect((await request.get("/api/events?run=x")).status()).toBe(401);
});

test("the account menu opens Preferences, a saved theme and range hold after a reload, and Sign out ends the session", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: COOKIE, value: await sessionToken(), url: baseURL! }]);
  await page.goto("/");
  await page.locator("header button[aria-haspopup=menu]").click();
  await page.getByRole("menuitem", { name: "Preferences" }).click();
  await expect(page.getByRole("heading", { name: "Preferences" })).toBeVisible();
  await page.getByLabel("Theme", { exact: true }).selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByLabel("Default range").selectOption("30d");
  await expect.poll(async () => (await (await page.request.get("/api/preferences")).json()).prefs.insightsRange).toBe("30d");
  await page.reload();
  await expect(page.getByLabel("Theme", { exact: true })).toHaveValue("dark");
  await page.goto("/insights");
  await expect(page.locator("#range")).toHaveValue("30d");
  await page.locator("header button[aria-haspopup=menu]").click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in/);
});

// The e2e session's sign-in may not act, so the save is refused; route.test.ts covers a save that goes through.
test("the Settings page opens from the menu with each target's form, and a refused save shows the server's reason", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: COOKIE, value: await sessionToken(), url: baseURL! }]);
  await page.goto("/insights");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  const demo = page.getByRole("tabpanel", { name: "demo" });
  await expect(demo.getByLabel("Most rounds of implement and fix")).toHaveValue("5");
  await demo.getByLabel("Most rounds of implement and fix").fill("3");
  await demo.getByRole("button", { name: "Save" }).click();
  await expect(demo.getByRole("alert")).toContainText("Could not save the settings for demo. This sign-in is off.");
});
