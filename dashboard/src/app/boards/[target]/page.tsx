import { notFound } from "next/navigation";
import { Board } from "@/components/board";
import { translator } from "@/lib/i18n";
import { sessionUser } from "@/server/auth";
import { readPrefs } from "@/server/preferences";
import { readTargets } from "@/server/targets";

export const dynamic = "force-dynamic";

export default async function TargetBoard({ params }: { params: Promise<{ target: string }> }) {
  const name = decodeURIComponent((await params).target);
  if (!readTargets().some((t) => t.name === name)) notFound();
  const me = await sessionUser();
  const t = translator((me && readPrefs(me).language) ?? "en");
  return (
    <main data-fill>
      {/* The breadcrumb names the page; the heading stays for screen readers. */}
      <h1 className="sr-only">{t("Board {name}", { name })}</h1>
      <Board target={name} />
    </main>
  );
}
