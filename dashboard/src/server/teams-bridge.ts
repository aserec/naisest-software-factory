import { createHmac, timingSafeEqual } from "node:crypto";
import { trackerOf } from "./compose";
import { NotSetUp } from "./not-set-up";
import { readTargets } from "./targets";
import { plainText, relayText } from "software-factory/relay";

// The Teams inbound bridge (docs/decisions/2026-11-06-dashboard-relays-teams-messages.md). A Teams outgoing webhook, one per target, POSTs here when someone
// @mentions it. The bridge checks the HMAC, finds the first `#123`, and posts the message on that work item as a quoted relay.
// The relay is posted by the relay bot, a tracker user below Developer (GitLab Reporter, GitHub read), so the comment itself never counts.
// The factory acts on it only when a trusted member adds 👍 on the tracker, and then as that member's comment (factory/relay.ts).
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

  const tracker = trackerOf(t);
  let res: Response | undefined;
  try {
    res = await tracker.postRelay(t, ticket, relayText(String(msg.from?.name ?? ""), text));
  } catch (e) {
    if (e instanceof NotSetUp) return reply("The Teams bridge has no tracker token. Nothing was posted.");
  }
  if (res?.status === 404) return reply(`${target} has no work item #${ticket}. Nothing was posted.`);
  if (!res?.ok) return reply(`The bridge could not post to ${target} #${ticket}${res ? ` (status ${res.status})` : ""}. Try again.`);
  return reply(`Posted on ${target} #${ticket}: ${tracker.ticketUrl(t, ticket)}. Add 👍 to it there for the factory to act on it.`);
}
