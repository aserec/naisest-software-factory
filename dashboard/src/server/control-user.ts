import { canAct, sessionActor } from "./auth";

// For the routes that change something: the user's name, or the 401 or 403 answer to return.
export async function controlUser(): Promise<string | Response> {
  const who = await sessionActor();
  if (!who) return new Response("sign in first", { status: 401 });
  if (!(await canAct({ accessToken: who.accessToken }))) return new Response("You need the Developer role on the factory project.", { status: 403 });
  return who.user;
}
