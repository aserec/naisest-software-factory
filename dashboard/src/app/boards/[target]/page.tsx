import { notFound } from "next/navigation";
import { Board } from "@/components/board";
import { readTargets } from "@/server/targets";

export const dynamic = "force-dynamic";

export default async function TargetBoard({ params }: { params: Promise<{ target: string }> }) {
  const name = decodeURIComponent((await params).target);
  if (!readTargets().some((t) => t.name === name)) notFound();
  return (
    <main data-fill>
      {/* The breadcrumb names the page; the heading stays for screen readers. */}
      <h1 className="sr-only">Board {name}</h1>
      <Board target={name} />
    </main>
  );
}
