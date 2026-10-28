// The real Repo: the target clone the agent works in, plus a git dir that only the factory controls.
// The factory never runs git with the clone's own .git: a hostile .git/config there could leak the token
// (insteadOf, extraHeader) or run code (fsmonitor, diff.external, textconv, filters, hooks).
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SETTINGS_PATH } from "../agents";
import type { Repo } from "./context";

const SRT = fileURLToPath(new URL("../../node_modules/.bin/srt", import.meta.url));
// Paths come from this file's place, not from env, which a trigger caller can set.
// The factory checkout's .git may hold CI_JOB_TOKEN in its remote URL; the runner keeps File-type variables in <project dir>.tmp.
export const FACTORY_ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");

export function sh(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }> {
  return new Promise((done, fail) => {
    const p = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", fail);
    p.on("close", (code) => done({ code, out }));
  });
}

// Sandbox settings for install and gate commands: the agent's network allowlist, no /proc,
// writes only to the clone, a throwaway HOME and /tmp.
export function sandboxSettings(dir: string, home: string) {
  const agent = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  return {
    network: { allowedDomains: agent.sandbox.network.allowedDomains, deniedDomains: [] },
    filesystem: { denyRead: ["/proc", `${FACTORY_ROOT}/.git`, `${FACTORY_ROOT}.tmp`, join(dirname(dir), "claude-home")], allowWrite: [dir, home, "/tmp"], denyWrite: [] },
  };
}

// Runs a target command (install, lint, test, build) inside @anthropic-ai/sandbox-runtime.
async function sandboxed(cmd: string, dir: string, env: NodeJS.ProcessEnv) {
  const home = mkdtempSync(join(tmpdir(), "gate-home-"));
  const settings = join(home, "srt-settings.json"); // srt reads it once, before the command starts
  writeFileSync(settings, JSON.stringify(sandboxSettings(dir, home)));
  try {
    return await sh(SRT, ["--settings", settings, "-c", cmd], dir, { PATH: env.PATH, LANG: env.LANG, HOME: home });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// gitDir is ours. The clone at dir is only used as a work tree.
export function gitRepo(dir: string, gitDir: string, url: string, token: string, env: NodeJS.ProcessEnv): Repo {
  // The token goes in a header through env, so it is never written to any config file.
  const auth = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`oauth2:${token}`).toString("base64")}` };
  const base = { PATH: env.PATH, HOME: env.HOME, LANG: env.LANG, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const safe = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=", "-c", "diff.external=", "-c", "commit.gpgsign=false"];
  const git = async (args: string[], extra: NodeJS.ProcessEnv = {}, cwd = dir) => {
    const r = await sh("git", [...safe, ...args], cwd, { ...base, ...extra });
    if (r.code !== 0) throw new Error(`git ${args.find((a) => !a.startsWith("-")) ?? ""} failed: ${r.out.slice(-500)}`);
    return r.out;
  };
  const ours = ["--git-dir", gitDir, "--work-tree", dir];
  return {
    async clone(ref) {
      if (existsSync(dir)) return;
      await git(["clone", "--depth", "1", "--branch", ref, url, dir], auth, ".");
      await git(["clone", "--bare", "--depth", "1", "--branch", ref, url, gitDir], auth, ".");
      appendFileSync(join(gitDir, "info/exclude"), "\nrun/\n"); // run/test-changes.md is a note, not part of the change
    },
    async diff() {
      await git([...ours, "add", "-A"]);
      const d = ["diff", "--cached", "--no-ext-diff", "--no-textconv"];
      return { text: await git([...ours, ...d, "HEAD"]), numstat: await git([...ours, ...d, "--numstat", "-z", "-M", "HEAD"]) };
    },
    async run(cmd) {
      const r = await sandboxed(cmd, dir, env);
      return { ok: r.code === 0, output: r.out };
    },
    // HEAD of our git dir stays the base commit. The new commit goes only to the branch on the server.
    async commitAndPush(branch, message) {
      await git([...ours, "add", "-A"]);
      const tree = (await git([...ours, "write-tree"])).trim();
      const who = { GIT_AUTHOR_NAME: "Software Factory", GIT_AUTHOR_EMAIL: "factory@noreply.invalid", GIT_COMMITTER_NAME: "Software Factory", GIT_COMMITTER_EMAIL: "factory@noreply.invalid" };
      const sha = (await git([...ours, "commit-tree", tree, "-p", "HEAD", "-m", message], who)).trim();
      // Force: a re-run replaces the earlier factory attempt on this factory-owned branch.
      await git(["--git-dir", gitDir, "push", "--force", url, `${sha}:refs/heads/${branch}`], auth);
      return sha;
    },
    readFile: (path) => (existsSync(join(dir, path)) ? readFileSync(join(dir, path), "utf8") : undefined),
  };
}
