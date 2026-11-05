import { DEV_LOGIN, sessionUser } from "./auth";
import { signIns } from "./sign-ins";

// For the routes that change something: the username, or the 401 or 403 answer to return.
// Browsers always send Origin on a POST or PUT, so a missing or foreign one is a cross-site request.
export const sameOrigin = (req: Request) => {
  const own = process.env.AUTH_URL && new URL(process.env.AUTH_URL).origin;
  return !!own && req.headers.get("origin") === own;
};

export async function controlUser(req: Request): Promise<string | Response> {
  if (!sameOrigin(req)) return new Response("cross-site request refused", { status: 403 });
  const who = await sessionUser();
  if (!who) return new Response("sign in first", { status: 401 });
  if (DEV_LOGIN && who.signIn === "dev") return who.username;
  const s = signIns().find((x) => x.id === who.signIn);
  if (!s) return new Response("This sign-in is off. Sign in again.", { status: 403 });
  const r = await s.canAct(who);
  return r === true ? who.username : new Response(s.messages[r.refused] ?? "refused", { status: 403 });
}
