import { isStuck } from "@/components/stuck";
import { auth } from "@/server/auth";
import type { RunSummary } from "@/server/db";
import { getDb } from "@/server/db-instance";
import { getBoard } from "@/server/compose";
import { readTargets } from "@/server/targets";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await auth())) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    const items = await getBoard().board();
    const limits = new Map(readTargets().map((t) => [t.name, t.stuckMinutes]));
    // runs() is newest first, so the first run of a ticket is its latest.
    const latest = new Map<string, RunSummary>();
    for (const r of getDb().runs({})) if (!latest.has(`${r.target}/${r.ticket}`)) latest.set(`${r.target}/${r.ticket}`, r);
    const now = new Date();
    return Response.json(
      items.map((i) => {
        const r = latest.get(`${i.target}/${i.ticket}`);
        const open = !!r && !r.endedAt;
        return {
          ...i, run: r?.run, costUsd: r?.costUsd, stuck: open && isStuck(r.lastStep, limits.get(i.target) ?? {}, now),
          step: open ? r.lastStep?.step : undefined, round: r?.round, mergeRisk: r?.mergeRisk, mergeRiskMax: r?.mergeRiskMax, changeUrl: r?.changeUrl,
        };
      }),
    );
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "board failed" }, { status: 502 });
  }
}
