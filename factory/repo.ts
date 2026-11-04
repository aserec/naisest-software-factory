// The real Repo: the target clone the agent works in, plus a git dir that only the factory controls.
// The factory never runs git with the clone's own .git: a hostile .git/config there could leak the token
// (insteadOf, extraHeader) or run code (fsmonitor, diff.external, textconv, filters, hooks).
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SANDBOX_RULES_PATH, sandboxDenyRead } from "./sandbox";
import { SRT } from "./srt";
import type { Repo } from "./seams";

// Paths come from this file's place, not from env, which a trigger caller can set.
// The factory checkout's .git may hold CI_JOB_TOKEN in its remote URL; the runner keeps File-type variables in <project dir>.tmp.
export const FACTORY_GIT_EMAIL = "factory@noreply.invalid"; // the author of every commit the factory makes
export const FACTORY_ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

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

// Sandbox settings for install and gate commands: the shared network allowlist, no /proc,
// writes only to the clone, a throwaway HOME and /tmp.
// A local run (store set) also gets the pnpm store, /private/tmp (the real /tmp on macOS, which srt does not follow)
// and local port binding (Next's Turbopack starts its PostCSS workers on a local port).
// ponytail: local binding also lets sandboxed code reach services on the developer's localhost. Local runs only.
export function sandboxSettings(dir: string, home: string, store?: string) {
  const rules = JSON.parse(readFileSync(SANDBOX_RULES_PATH, "utf8"));
  return {
    network: { allowedDomains: rules.network.allowedDomains, deniedDomains: [], ...(store && { allowLocalBinding: true }) },
    filesystem: { denyRead: sandboxDenyRead(dir), allowWrite: [dir, home, "/tmp", ...(store ? [store, "/private/tmp"] : [])], denyWrite: [] },
  };
}

// Runs a target command (install, lint, test, build) inside @anthropic-ai/sandbox-runtime.
async function sandboxed(cmd: string, dir: string, env: NodeJS.ProcessEnv) {
  // ponytail: local runs only (local-run.sh sets it; the CI job env list never passes it). One shared store, so an
  // install script of one run can change what a later run installs. CI gets a new VM per job and never uses it.
  const store = env.FACTORY_PNPM_STORE;
  if (store && !isAbsolute(store)) throw new Error("FACTORY_PNPM_STORE must be an absolute path");
  const home = mkdtempSync(join(tmpdir(), "gate-home-"));
  const settings = join(home, "srt-settings.json"); // srt reads it once, before the command starts
  writeFileSync(settings, JSON.stringify(sandboxSettings(dir, home, store)));
  try {
    // srt on macOS denies writes to every .idea, .vscode and .git/hooks under its cwd, and some packages ship an .idea dir
    // (iconv-lite 0.6.3). Local runs start srt in the throwaway HOME, so those rules cover HOME and not the clone.
    // The factory never uses the clone's own .git, so the clone loses nothing it relies on.
    const script = store ? `cd '${dir.replaceAll("'", `'\\''`)}' && ${cmd}` : cmd;
    return await sh(SRT, ["--settings", settings, "-c", script], store ? home : dir, { PATH: env.PATH, LANG: env.LANG, HOME: home, ...(store && { pnpm_config_store_dir: store }) });
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
      // Our git dir takes the exact commit the clone got: a second clone of the branch could get a newer one.
      // The clone is fresh here, so its .git is still the one git wrote.
      const sha = (await git(["rev-parse", "HEAD"])).trim();
      await git(["init", "-q", "--bare", gitDir], {}, ".");
      await git(["--git-dir", gitDir, "fetch", "-q", "--depth", "1", url, sha], auth);
      await git(["--git-dir", gitDir, "update-ref", "--no-deref", "HEAD", sha]);
      // A bare clone has no index. Start it from the base commit, so `add -A` keeps tracked files under ignored paths and submodules.
      await git([...ours, "read-tree", "HEAD"]);
      appendFileSync(join(gitDir, "info/exclude"), "\n/run/\n"); // run/test-changes.md is a note, not part of the change. Root only: src/run/ is code
      // The agent writes its notes and proof here. A missing run/ made an agent take run/ for the factory's own folder.
      mkdirSync(join(dir, "run/proof"), { recursive: true });
    },
    async diff() {
      await git([...ours, "add", "-A"]);
      // --text: a `-diff` in the agent's .gitattributes would otherwise hide every line from the review, the secret scan and the size rule.
      const d = ["diff", "--cached", "--text", "--no-ext-diff", "--no-textconv"];
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
      const who = { GIT_AUTHOR_NAME: "Software Factory", GIT_AUTHOR_EMAIL: FACTORY_GIT_EMAIL, GIT_COMMITTER_NAME: "Software Factory", GIT_COMMITTER_EMAIL: FACTORY_GIT_EMAIL };
      const sha = (await git([...ours, "commit-tree", tree, "-p", "HEAD", "-m", message], who)).trim();
      // Force: a re-run replaces the earlier factory attempt on this factory-owned branch.
      await git(["--git-dir", gitDir, "push", "--force", url, `${sha}:refs/heads/${branch}`], auth);
      return sha;
    },
    // Reads from our git dir, so nothing the agent wrote in the work tree can change the answer.
    async readBase(path) {
      try {
        // LC_ALL=C: the check below reads git's English message, whatever LANG the runner has.
        return await git(["--git-dir", gitDir, "show", `HEAD:${path}`], { LC_ALL: "C" });
      } catch (e) {
        if (/does not exist|exists on disk, but not in/.test(String(e))) return undefined;
        throw e;
      }
    },
    // The agent writes the clone, so a link there could point at a secret file. Read only plain files inside it.
    readFile(path) {
      const full = join(dir, path);
      if (!existsSync(full)) return undefined;
      if (lstatSync(full).isSymbolicLink() || !realpathSync(full).startsWith(realpathSync(dir) + sep)) throw new Error(`Refused to read ${path}: it is a link or it leaves the clone`);
      return readFileSync(full, "utf8");
    },
    // Same checks as readFile. A refused file is not an error here: the proof shows without that image.
    readBytes(path, maxBytes) {
      try {
        const full = join(dir, path);
        if (!existsSync(full) || lstatSync(full).isSymbolicLink() || !realpathSync(full).startsWith(realpathSync(dir) + sep)) return undefined;
        const st = statSync(full);
        return st.isFile() && st.size <= maxBytes ? readFileSync(full) : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
