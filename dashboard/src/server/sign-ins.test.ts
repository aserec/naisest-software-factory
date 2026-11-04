import { beforeEach, expect, it, vi } from "vitest";
import { signIns } from "./sign-ins";

beforeEach(() => {
  vi.stubEnv("GITLAB_OAUTH_CLIENT_ID", "");
  vi.stubEnv("GITHUB_OAUTH_CLIENT_ID", "");
  vi.stubEnv("GITLAB_URL", "");
});

it("only sign-ins with a client id are on, GitLab first", () => {
  expect(signIns()).toEqual([]);
  vi.stubEnv("GITHUB_OAUTH_CLIENT_ID", "gh");
  expect(signIns().map((s) => s.id)).toEqual(["github"]);
  vi.stubEnv("GITLAB_OAUTH_CLIENT_ID", "gl");
  vi.stubEnv("GITLAB_URL", "https://gitlab.test");
  expect(signIns().map((s) => s.id)).toEqual(["gitlab", "github"]);
});

it("GitLab sign-in stays off without GITLAB_URL", () => {
  vi.stubEnv("GITLAB_OAUTH_CLIENT_ID", "gl");
  expect(signIns()).toEqual([]);
});

