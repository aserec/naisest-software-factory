import { canAct, sessionUser } from "./auth";

// For the routes that change something: the GitLab username, or the 401 or 403 answer to return.
// Browsers always send Origin on a POST or PUT, so a missing or foreign one is a cross-site request.
export async function controlUser(req: Request): Promise<string | Response> {
  const own = process.env.AUTH_URL && new URL(process.env.AUTH_URL).origin;
  if (!own || req.headers.get("origin") !== own) return new Response("cross-site request refused", { status: 403 });
  const who = await sessionUser();
  if (!who) return new Response("sign in first", { status: 401 });
  if (!(await canAct(who.userId))) return new Response("You need the Developer role on the factory project.", { status: 403 });
  return who.username;
}
