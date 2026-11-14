// A browser outside the sandbox for the target's Playwright tests, on macOS only.
// Inside the sandbox Chromium cannot start: it needs mach-register, which no sandbox setting allows. The single-process
// workaround (see local-run.sh) dies when a test closes its context, so it serves screenshots but not a test suite.
// So the factory starts the target's Playwright version as a browser server, and the sandboxed tests connect to it
// through PW_TEST_CONNECT_WS_ENDPOINT. The server runs under its own macOS profile: it may reach only localhost and
// write only temp dirs, so a page the agent wrote cannot send the repo anywhere.
// ponytail: Linux starts no server; Chromium is expected to run inside its sandbox there. Add it if the runner image shows otherwise.
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./sandbox";

export const BROWSER_ENDPOINT = "PW_TEST_CONNECT_WS_ENDPOINT";

const PROFILE = `(version 1)
(allow default)
(deny network-outbound)
(allow network-outbound (remote ip "localhost:*"))
(allow network-outbound (remote unix-socket))
(deny file-write*)
(allow file-write* (subpath "/private/tmp") (subpath "/private/var/folders") (literal "/dev/null"))
`;

// The clone's Playwright version. The agent can write the file, so only a plain x.y.z counts.
// pnpm without shamefullyHoist links only direct dependencies at the top, so playwright-core may be missing there
// (the webapp after its pnpm move: every e2e test ran inside the sandbox and failed). playwright and @playwright/test
// share playwright-core's version.
export function playwrightVersion(clone: string): string | undefined {
  for (const pkg of ["playwright-core", "playwright", "@playwright/test"]) {
    try {
      const v = JSON.parse(readFileSync(join(clone, "node_modules", pkg, "package.json"), "utf8")).version;
      return typeof v === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(v) ? v : undefined;
    } catch {
      // not installed under this name
    }
  }
  return undefined;
}

// Our own copy of that version from npm, never the clone's: the server runs outside the sandbox.
function playwrightCli(version: string, env: NodeJS.ProcessEnv): string {
  const dir = `${ROOT}/.cache/playwright/${version}`;
  const cli = join(dir, "node_modules/playwright-core/cli.js");
  const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { env, stdio: "pipe", timeout: 600_000 });
  if (!existsSync(cli)) run("npm", ["install", "--silent", "--no-audit", "--no-fund", "--ignore-scripts", "--prefix", dir, `playwright-core@${version}`]);
  run(process.execPath, [cli, "install", "chromium"]); // quick when the browser is there
  return cli;
}

interface Server { endpoint: string; stop(): void }

async function start(version: string, env: NodeJS.ProcessEnv, dir: string): Promise<Server> {
  const cli = playwrightCli(version, env);
  writeFileSync(join(dir, "browser.sb"), PROFILE);
  // A secret path: other local processes cannot guess the endpoint.
  writeFileSync(join(dir, "server.json"), JSON.stringify({ host: "127.0.0.1", port: 0, wsPath: `/${randomBytes(16).toString("hex")}` }));
  const child = spawn("sandbox-exec", ["-f", join(dir, "browser.sb"), process.execPath, cli, "launch-server", "--browser", "chromium", "--config", join(dir, "server.json")], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const stop = () => {
    try { process.kill(-child.pid!, "SIGTERM"); } catch { /* already gone */ }
  };
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => reject(new Error(`no endpoint in 60 s: ${out.slice(-500)}`)), 60_000);
      const read = (b: Buffer) => {
        out += b.toString();
        const m = out.match(/ws:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}/);
        if (m) { clearTimeout(timer); resolve(m[0]); }
      };
      child.stdout!.on("data", read);
      child.stderr!.on("data", read);
      child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`exited with ${code}: ${out.slice(-500)}`)); });
    });
    return { endpoint, stop };
  } catch (e) {
    stop();
    throw e;
  }
}

// Runs fn with the endpoint variable when the clone has Playwright on macOS, else with none.
// A server that does not start is logged, and fn runs without it: the tests then fail with their own error.
export async function withBrowserServer<T>(clone: string, env: NodeJS.ProcessEnv, fn: (vars: Record<string, string>) => Promise<T>, platform = process.platform): Promise<T> {
  const version = platform === "darwin" && clone ? playwrightVersion(clone) : undefined; // no clone: an agent with no tools
  if (!version) return fn({});
  // The real browsers dir: local-run.sh points PLAYWRIGHT_BROWSERS_PATH at the single-process copy for the sandbox.
  const { PLAYWRIGHT_BROWSERS_PATH: _, ...serverEnv } = env;
  const dir = mkdtempSync(join(tmpdir(), "browser-server-"));
  let server: Server | undefined;
  try {
    try {
      server = await start(version, serverEnv, dir);
    } catch (e) {
      console.log(`Could not start a browser server for Playwright ${version}: ${e instanceof Error ? e.message : e}`);
    }
    return await fn(server ? { [BROWSER_ENDPOINT]: server.endpoint } : {});
  } finally {
    server?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}
