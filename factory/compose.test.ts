import { expect, test, vi } from "vitest";
import { botAccount, commentOnce } from "./compose";
import { asFactoryMention, commandIn, isRequest } from "./conversation";
import type { Target } from "./types";
import { fakeCodeHost } from "./fakes";

test("commentOnce skips a comment that repeats the newest one, and posts it again after a person writes", async () => {
  const fake = fakeCodeHost();
  const host = commentOnce(fake);
  const { ref } = await host.openChange("factory/8-x", "A", "t", "8");
  await host.commentChange(ref, "Merging");
  await host.commentChange(ref, "Merging");
  expect(fake.mrComments).toEqual(["Merging"]);
  fake.sayOnChange(ref, "ann", "why?");
  await host.commentChange(ref, "Merging");
  await host.commentChange(ref, "Other");
  expect(fake.mrComments).toEqual(["Merging", "Merging", "Other"]);
});

// GitHub answers for the bot token: push on the repo, the board's viewerCanUpdate, then /user.
function fakeGitHub(push: boolean, canUpdate = true) {
  return vi.fn(async (url: string) => {
    const json = url.endsWith("/graphql") ? { data: { repositoryOwner: { projectV2: { viewerCanUpdate: canUpdate } } } }
      : url.endsWith("/user") ? { login: "sf-bot", id: 7 } : { permissions: { push } };
    return new Response(JSON.stringify(json), { status: 200 });
  });
}
const target = { name: "t", githubRepo: "acme/app", githubProject: 3 } as Target;

test("botAccount uses the bot only where it may push and edit the board, with its no-reply email unless FACTORY_GIT_EMAIL is set", async () => {
  vi.stubGlobal("fetch", fakeGitHub(true));
  expect(await botAccount("FACTORY_BOT_GITHUB_TOKEN", "x", target, {})).toEqual({ login: "sf-bot", email: "7+sf-bot@users.noreply.github.com" });
  expect(await botAccount("FACTORY_BOT_GITHUB_TOKEN", "x", target, { FACTORY_GIT_EMAIL: "sf@example.com" })).toEqual({ login: "sf-bot", email: "sf@example.com" });
  vi.stubGlobal("fetch", fakeGitHub(false));
  expect(await botAccount("FACTORY_BOT_GITHUB_TOKEN", "x", target, {})).toBeUndefined();
  vi.stubGlobal("fetch", fakeGitHub(true, false));
  expect(await botAccount("FACTORY_BOT_GITHUB_TOKEN", "x", target, {})).toBeUndefined();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(await botAccount("FACTORY_BOT_GITHUB_TOKEN", "x", target, {})).toBeUndefined();
  vi.unstubAllGlobals();
});

test("a mention of the bot's login reads as @factory, and a longer login or an email does not", () => {
  expect(commandIn(asFactoryMention("@SF-Bot stop", "sf-bot"))).toBe("stop");
  expect(isRequest(asFactoryMention("please @sf-bot add a test", "sf-bot"))).toBe(true);
  expect(isRequest(asFactoryMention("@sf-bot-old add a test", "sf-bot"))).toBe(false);
  expect(isRequest(asFactoryMention("mail me at me@sf-bot", "sf-bot"))).toBe(false);
});
