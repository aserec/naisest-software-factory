import Link from "next/link";
import { RunControls } from "@/components/run-controls";
import { RunTimeline } from "@/components/run-timeline";
import { getDb } from "@/server/db-instance";
import { readTargets } from "@/server/targets";

export const dynamic = "force-dynamic";

export default async function RunPage({ params }: { params: Promise<{ run: string }> }) {
  const { run } = await params;
  const target = getDb().events({ run, limit: 1 }).events[0]?.target;
  const limits = readTargets().find((t) => t.name === target)?.stuckMinutes;
  return (
    <main className="p-6">
      <Link href="/" className="text-sm underline">
        Back to the board
      </Link>
      <h1 className="mb-4 text-2xl font-semibold">Run {run}</h1>
      <RunControls run={run} />
      <RunTimeline run={run} limits={limits} />
    </main>
  );
}
