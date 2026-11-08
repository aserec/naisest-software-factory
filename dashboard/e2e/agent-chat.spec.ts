import { expect, test } from "@playwright/test";
import { COOKIE, RUN, sessionToken } from "./seed";

test("the chat panel opens beside a run page, stays open after a reload, and covers the page on a phone", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: COOKIE, value: await sessionToken(), url: baseURL! }]);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/runs/${RUN}`);
  const chat = page.getByRole("complementary", { name: "Agent chat" });
  await expect(chat).toBeHidden();
  const toggle = page.getByRole("button", { name: "Chat" });
  await toggle.click();
  await expect(chat).toBeVisible();
  await expect(chat.getByText("Ask about this page.")).toBeVisible();
  // Beside the content: the panel starts right of the sheet.
  const sheet = page.locator("[data-sheet]");
  expect((await sheet.boundingBox())!.x + (await sheet.boundingBox())!.width).toBeLessThanOrEqual((await chat.boundingBox())!.x);
  await page.screenshot({ path: test.info().outputPath("agent-chat.png") });

  await page.reload();
  await expect(chat).toBeVisible();

  await page.setViewportSize({ width: 390, height: 800 });
  const box = (await chat.boundingBox())!;
  expect(box.x).toBe(0);
  expect(box.width).toBe(390);
  await toggle.click();
  await expect(chat).toBeHidden();
});
