import { SWITCHES, type SwitchName } from "software-factory/run-events";
import { auth } from "@/server/auth";
import { controlUser } from "@/server/control-user";
import { getDb } from "@/server/db-instance";
import { readTargets } from "@/server/targets";

const scopes = () => ["*", ...readTargets().map((t) => t.name)];

// Every scope with its switches. A target shows what is in force for it, so it is off when the "*" row is off.
export async function GET() {
  if (!(await auth())) return new Response("sign in first", { status: 401 });
  const db = getDb();
  return Response.json(Object.fromEntries(scopes().map((s) => [s, db.switches(s)])));
}

export async function PUT(req: Request) {
  const user = await controlUser(req);
  if (typeof user !== "string") return user;
  const body = (await req.json().catch(() => undefined)) as { scope?: unknown; name?: unknown; on?: unknown } | undefined;
  const { scope, name, on } = body ?? {};
  if (typeof scope !== "string" || !scopes().includes(scope)) return new Response("scope must be * or a target name", { status: 400 });
  if (!SWITCHES.includes(name as SwitchName)) return new Response("unknown switch", { status: 400 });
  if (typeof on !== "boolean") return new Response("on must be true or false", { status: 400 });
  getDb().setSwitch(scope, name as SwitchName, on, user);
  return new Response(null, { status: 204 });
}
