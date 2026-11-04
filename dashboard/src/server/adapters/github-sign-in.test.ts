import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { signInContract } from "../contracts/sign-in.contract";
import { makeGitHubSignIn } from "./github-sign-in";

beforeEach(() => {
  vi.stubEnv("GITHUB_READ_TOKEN", "read-token");
  const dir = mkdtempSync(join(tmpdir(), "targets-"));
  writeFileSync(join(dir, "a.yml"), "name: a\nprojectPath: o/a\ntracker: github\ngithubRepo: o/a\n");
  writeFileSync(join(dir, "b.yml"), "name: b\nprojectPath: o/b\ntracker: github\ngithubRepo: o/b\n");
  writeFileSync(join(dir, "gl.yml"), "name: gl\nprojectPath: g/x\n");
  vi.stubEnv("TARGETS_DIR", dir);
});

// A fake GitHub answering the collaborator permission read, with the server's read token only. A number is a status.
function fakeGitHub(perms: Record<string, string | number>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if ((init?.headers as Record<string, string>).Authorization !== "Bearer read-token") return new Response("no", { status: 401 });
    const m = /repos\/(.+)\/collaborators\/ann\/permission$/.exec(url);
    const p = m ? perms[m[1]] : 404;
    return typeof p === "number" ? new Response("no", { status: p }) : Response.json({ permission: p });
  }) as unknown as typeof fetch;
}

const profile = { id: 9, login: "ann", name: "Ann" };
const user = { userId: 9, username: "ann", signIn: "github" };

signInContract("GitHub", () => {
  const perms: Record<string, string | number> = { "o/a": "read", "o/b": "write" };
  return { signIn: makeGitHubSignIn(fakeGitHub(perms)), account: {}, profile, allow: (ok) => void (perms["o/b"] = ok ? "write" : "read") };
});

it("lets in write or admin on any GitHub target's repo, as the GitHub login", async () => {
  for (const p of ["write", "admin"]) expect(await makeGitHubSignIn(fakeGitHub({ "o/a": "read", "o/b": p })).check({}, profile)).toEqual({ user });
});

it("refuses read, no answer, an error, and a profile without a login, with the exact text", async () => {
  const thrown = vi.fn(async () => {
    throw new Error("network");
  }) as unknown as typeof fetch;
  for (const f of [fakeGitHub({ "o/a": "read", "o/b": "read" }), fakeGitHub({ "o/a": 404, "o/b": 500 }), thrown]) {
    const s = makeGitHubSignIn(f);
    expect(await s.check({}, profile)).toEqual({ refused: "role" });
    expect(await s.canAct(user)).toEqual({ refused: "role" });
    expect(s.messages.role).toBe("You need write access to the repo of a GitHub target.");
  }
  const f = fakeGitHub({ "o/b": "write" });
  expect(await makeGitHubSignIn(f).check({}, { id: 9 })).toEqual({ refused: "role" });
  expect(f).not.toHaveBeenCalled();
});
