import { expect, test } from "vitest";
import { ADAPTER_NAMES } from "./compose";
import { ADAPTER_SECRETS, FILE_SECRETS } from "./secrets";

test("every tracker, code host and chat adapter in compose has a secret entry or is console", () => {
  for (const n of ADAPTER_NAMES.tracker) expect(ADAPTER_SECRETS.tracker).toHaveProperty(n);
  for (const n of ADAPTER_NAMES.codeHost) expect(ADAPTER_SECRETS.codeHost).toHaveProperty(n);
  for (const n of ADAPTER_NAMES.chat) expect(n === "console" || n in ADAPTER_SECRETS.chat).toBe(true);
});

test("FILE_SECRETS keeps today's list", () => {
  expect(FILE_SECRETS).toEqual(["FACTORY_GITLAB_TOKEN", "FACTORY_GITHUB_TOKEN", "TEAMS_WEBHOOK_URL", "FACTORY_DASHBOARD_TOKEN"]);
});
