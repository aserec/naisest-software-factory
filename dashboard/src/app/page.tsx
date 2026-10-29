import Link from "next/link";
import { Board } from "@/components/board";

export default function Home() {
  return (
    <main className="p-6">
      <div className="mb-4 flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Factory</h1>
        <nav className="flex gap-4 text-sm">
          <Link href="/runner" className="underline">
            Runner
          </Link>
          <Link href="/switches" className="underline">
            Switches
          </Link>
        </nav>
      </div>
      <Board />
    </main>
  );
}
