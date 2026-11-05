import { auth } from "@/server/auth";
import { getDb } from "@/server/db-instance";

// The last 50 switch changes, newest first, for the History section on the switches page.
export async function GET() {
  if (!(await auth())) return new Response("sign in first", { status: 401 });
  return Response.json(getDb().switchChanges(50));
}
