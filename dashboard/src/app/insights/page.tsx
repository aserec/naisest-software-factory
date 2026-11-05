import { InsightsPanel } from "@/components/insights-panel";
import { loadInsights } from "@/server/insights-load";

export const dynamic = "force-dynamic";

// The first range renders on the server; a new range loads in the panel without leaving the page.
export default async function InsightsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = await searchParams;
  return (
    <main>
      <InsightsPanel initial={loadInsights(q)} hasZone={!!q.tz} />
    </main>
  );
}
