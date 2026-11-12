import { redirect } from "next/navigation";
import { Board } from "@/components/board";
import { BoardsOverview } from "@/components/boards-overview";
import { sessionUser } from "@/server/auth";
import { loadInsights } from "@/server/insights-load";
import { readPrefs } from "@/server/preferences";
import { readTargets } from "@/server/targets";
import { translator } from "@/lib/i18n";

export const dynamic = "force-dynamic";

// The overview of every target's board for a range; an old ?target= link opens that target's board.
// With no targets read, the one board shows them all.
export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = await searchParams;
  const names = readTargets().map((t) => t.name);
  if (q.target && names.includes(q.target)) redirect(`/boards/${encodeURIComponent(q.target)}`);
  if (!names.length) {
    const me = await sessionUser();
    const t = translator((me && readPrefs(me).language) ?? "en");
    return (
      <main data-fill>
        <h1 className="sr-only">{t("Board")}</h1>
        <Board />
      </main>
    );
  }
  const user = q.range ? undefined : await sessionUser();
  if (user) q.range = readPrefs(user).insightsRange;
  return (
    <main>
      <BoardsOverview initial={loadInsights(q)} hasZone={!!q.tz} targets={names} />
    </main>
  );
}
