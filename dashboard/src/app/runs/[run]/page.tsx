import Link from "next/link";
import { RunTimeline } from "@/components/run-timeline";

export default async function RunPage({ params }: { params: Promise<{ run: string }> }) {
  const { run } = await params;
  return (
    <main className="p-6">
      <Link href="/" className="text-sm underline">
        Back to the board
      </Link>
      <h1 className="mb-4 text-2xl font-semibold">Run {run}</h1>
      <RunTimeline run={run} />
    </main>
  );
}
