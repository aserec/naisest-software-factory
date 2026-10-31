import Link from "next/link";
import { RunnerView } from "@/components/runner-view";

export default function RunnerPage() {
  return (
    <main className="p-6">
      <Link href="/" className="text-sm underline">
        Back to the board
      </Link>
      <h1 className="mb-4 text-2xl font-semibold">Runner</h1>
      <RunnerView />
    </main>
  );
}
