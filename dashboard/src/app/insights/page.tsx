import { InsightsPanel } from "@/components/insights-panel";
import { sessionUser } from "@/server/auth";
import { loadInsights } from "@/server/insights-load";
import { readPrefs } from "@/server/preferences";

export const dynamic = "force-dynamic";

// The first range renders on the server; a new range loads in the panel without leaving the page.
// With no range in the URL, the user's saved default range.
export default async function InsightsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = await searchParams;
  const user = q.range ? undefined : await sessionUser();
  if (user) q.range = readPrefs(user).insightsRange;
  return (
    <main>
      <InsightsPanel initial={loadInsights(q)} hasZone={!!q.tz} />
    </main>
  );
}
