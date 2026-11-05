import { sameOrigin } from "@/server/control-user";
import { sessionUser } from "@/server/auth";
import { PREFS } from "@/lib/preferences";
import { readPrefs, savePrefs } from "@/server/preferences";
import { signIns } from "@/server/sign-ins";

// The signed-in user and their preferences. Any signed-in user may change their own; no role is needed.
export async function GET() {
  const u = await sessionUser();
  if (!u) return new Response("sign in first", { status: 401 });
  const signIn = signIns().find((s) => s.id === u.signIn)?.name ?? u.signIn;
  return Response.json({ user: { username: u.username, signIn }, prefs: readPrefs(u) });
}

// Takes some of the preferences and keeps the rest. Answers with all of them.
export async function PUT(req: Request) {
  if (!sameOrigin(req)) return new Response("cross-site request refused", { status: 403 });
  const u = await sessionUser();
  if (!u) return new Response("sign in first", { status: 401 });
  const body = PREFS.partial().safeParse(await req.json().catch(() => undefined));
  if (!body.success) return new Response(body.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "), { status: 400 });
  return Response.json(savePrefs(u, body.data));
}
