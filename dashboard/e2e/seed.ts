import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { encode } from "next-auth/jwt";
import { APP, STUB_PORT } from "../playwright.config";

export const RUN = "run-e2e";
export const COOKIE = "authjs.session-token"; // the plain name, because the app runs on http

// A session as the jwt callback in src/server/auth.ts stores it. The GitLab token never expires here, so nothing refreshes.
export function sessionToken() {
  return encode({
    token: { name: "ann", sub: "1", userId: 1, accessToken: "stub", refreshToken: "stub", expiresAt: Date.now() + 365 * 864e5, loginAt: Date.now() },
    secret: process.env.AUTH_SECRET!,
    salt: COOKIE,
    maxAge: 8 * 3600,
  });
}

// A stub of the GitLab calls the board and the job log make.
function startStub() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    if (url.pathname === "/api/v4/projects/g%2Fdemo/issues") {
      const running = url.searchParams.get("labels") === "factory_running";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(running ? [{ iid: 7, title: "Fix login", web_url: "http://localhost/g/demo/-/issues/7", updated_at: new Date().toISOString() }] : []));
    } else if (url.pathname === "/api/v4/projects/1/jobs/42/trace") {
      res.end("log line from the stub");
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  return new Promise<() => Promise<void>>((resolve) => server.listen(STUB_PORT, () => resolve(() => new Promise((done) => server.close(() => done())))));
}

function events() {
  const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const base = { run: RUN, target: "demo", ticket: "7" };
  const step = randomUUID();
  return [
    { id: randomUUID(), ...base, at: at(10), type: "run_start", data: {} },
    { id: step, ...base, at: at(9), step: "prepare-patch", job: "42", type: "step_start", data: { prompt: "Fix the login bug" } },
    { id: randomUUID(), ...base, at: at(8), step: "prepare-patch", parent: step, type: "tool_call", data: { name: "Edit", input: "src/login.ts", result: "ok", ms: 12, ok: true } },
    { id: randomUUID(), ...base, at: at(7), step: "prepare-patch", type: "usage", data: { role: "author", model: "m", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0.25, contextTokens: 1 } },
    { id: randomUUID(), ...base, at: at(6), step: "prepare-patch", type: "step_end", data: { outcome: "next" } },
    { id: randomUUID(), ...base, at: at(5), step: "code-review", type: "step_start", data: {} },
  ];
}

// Playwright runs this after it started the app: it starts the stub and sends the events through the collector route.
export default async function globalSetup() {
  const stopStub = await startStub();
  const r = await fetch(`${APP}/api/events`, { method: "POST", headers: { authorization: `Bearer ${process.env.FACTORY_DASHBOARD_TOKEN}` }, body: JSON.stringify(events()) });
  if (!r.ok) throw new Error(`Seeding the events failed: ${r.status} ${await r.text()}`);
  return stopStub;
}
