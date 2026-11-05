import type { NextRequest } from "next/server";
import { auth } from "@/server/auth";
import { loadInsights } from "@/server/insights-load";

export const dynamic = "force-dynamic";

// The Insights page asks here when a person picks another range, so only the page's content changes.
export async function GET(req: NextRequest) {
  if (!(await auth())) return Response.json({ error: "unauthorized" }, { status: 401 });
  const p = req.nextUrl.searchParams;
  return Response.json(loadInsights({ range: p.get("range") ?? undefined, from: p.get("from") ?? undefined, to: p.get("to") ?? undefined, tz: p.get("tz") ?? undefined }));
}
