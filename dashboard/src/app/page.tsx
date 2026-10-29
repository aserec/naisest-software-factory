import Link from "next/link";
import { Board } from "@/components/board";

export default function Home() {
  return (
    <main className="p-6">
      <div className="mb-4 flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Factory</h1>
        <Link href="/switches" className="text-sm underline">
          Switches
        </Link>
      </div>
      <Board />
    </main>
  );
}
