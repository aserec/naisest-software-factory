import { createHmac, timingSafeEqual } from "node:crypto";
import { githubApi } from "./adapters/github-url";
import { gitlabUrl } from "./adapters/gitlab-url";
import { trackerOf } from "./compose";
import { readTargets, type TargetInfo } from "./targets";
import { plainText, relayText } from "./teams-relay";

// The Teams inbound bridge (spec 2026-10-28 §9 Teams, phase 2). A Teams outgoing webhook, one per target, POSTs here when someone
// @mentions it. The bridge checks the HMAC, finds the first `#123`, and posts the message on that work item as a quoted relay.
// The relay is posted by the relay bot, a tracker user below Developer (GitLab Reporter, GitHub read). The factory acts only on comments
// of trusted members, so it never acts on a relay and never gives one to an agent: a Teams message cannot start, stop or steer a run.
// Members who want the factory to act comment on the work item themselves.

// The security token Teams shows once when the outgoing webhook is made, per target: TEAMS_OUTGOING_TOKEN_<TARGET>.
export const tokenEnv = (target: string) => `TEAMS_OUTGOING_TOKEN_${target.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;

// Teams signs the raw body: Authorization: HMAC base64(HMAC-SHA256(key = base64-decoded token, body)).
function signed(raw: Buffer, header: string | null, token: string | undefined): boolean {
  const m = /^HMAC (\S+)$/.exec(header ?? "");
  if (!m || !token) return false;
  const want = createHmac("sha256", Buffer.from(token, "base64")).update(raw).digest();
  const got = Buffer.from(m[1], "base64");
  return got.length === want.length && timingSafeEqual(got, want);
}

function commentRequest(t: TargetInfo, ticket: string, body: string): { url: string; init: RequestInit } | undefined {
  const json = { method: "POST", body: JSON.stringify({ body }), signal: AbortSignal.timeout(4000) }; // Teams waits 5 s for the answer
  if (t.tracker === "gitlab") {
    const token = process.env.TEAMS_RELAY_GITLAB_TOKEN;
    const base = gitlabUrl();
    if (!token || !base) return undefined;
    return { url: `${base}/api/v4/projects/${encodeURIComponent(t.projectPath)}/issues/${ticket}/notes`, init: { ...json, headers: { "PRIVATE-TOKEN": token, "Content-Type": "application/json" } } };
  }
  const token = process.env.TEAMS_RELAY_GITHUB_TOKEN;
  if (!token || !t.githubRepo) return undefined;
  return { url: `${githubApi()}/repos/${t.githubRepo}/issues/${ticket}/comments`, init: { ...json, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" } } };
}

const reply = (text: string) => Response.json({ type: "message", text });

export async function handleTeams(req: Request, target: string): Promise<Response> {
  const t = readTargets().find((x) => x.name === target);
  const raw = Buffer.from(await req.arrayBuffer());
  if (!t || !signed(raw, req.headers.get("authorization"), process.env[tokenEnv(target)])) return Response.json({ error: "unauthorized" }, { status: 401 });

  let msg: { text?: unknown; from?: { name?: unknown } };
  try {
    msg = JSON.parse(raw.toString("utf8"));
  } catch {
    return Response.json({ error: "not JSON" }, { status: 400 });
  }
  const text = plainText(String(msg.text ?? ""));
  const ticket = /(?<![\w&])#(\d+)\b/.exec(text)?.[1];
  if (!ticket) return reply("Name the work item with its number, for example #123. Nothing was posted.");

  const r = commentRequest(t, ticket, relayText(String(msg.from?.name ?? ""), text));
  if (!r) return reply("The Teams bridge has no tracker token. Nothing was posted.");
  const res = await fetch(r.url, r.init).catch(() => undefined);
  if (res?.status === 404) return reply(`${target} has no work item #${ticket}. Nothing was posted.`);
  if (!res?.ok) return reply(`The bridge could not post to ${target} #${ticket}${res ? ` (status ${res.status})` : ""}. Try again.`);
  return reply(`Posted on ${target} #${ticket}: ${trackerOf(t).ticketUrl(t, ticket)}. It is information only: to steer the factory, comment on the work item.`);
}
