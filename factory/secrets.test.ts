import { expect, test, vi } from "vitest";
import { FILE_SECRETS } from "./secrets";

test("compose loads only when every tracker, code host and chat adapter has a secret entry or is console", async () => {
  await expect(import("./compose")).resolves.toBeDefined();
  vi.resetModules();
  delete (await import("./secrets")).ADAPTER_SECRETS.chat.slack;
  await expect(import("./compose")).rejects.toThrow("secrets.ts names no secret for chat adapter slack");
});

test("FILE_SECRETS keeps today's list", () => {
  expect(FILE_SECRETS).toEqual(["FACTORY_GITLAB_TOKEN", "FACTORY_GITHUB_TOKEN", "TEAMS_WEBHOOK_URL", "SLACK_WEBHOOK_URL", "FACTORY_DASHBOARD_TOKEN"]);
});
