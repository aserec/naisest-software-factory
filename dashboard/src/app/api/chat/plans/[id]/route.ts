import { controlUser } from "@/server/control-user";
import { getDb } from "@/server/db-instance";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await controlUser(req);
  if (typeof user !== "string") return user;
  const r = getDb().approvePlan((await params).id, user);
  return "refused" in r ? new Response(r.refused, { status: 409 }) : Response.json(r);
}
