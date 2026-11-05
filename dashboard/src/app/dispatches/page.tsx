"use client";

import { useQuery } from "@tanstack/react-query";
import { LoadError, PageTitle, SectionHeading } from "@/components/shell";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { ago } from "@/lib/utils";
import type { DispatchLog } from "@/server/db";

type Targets = { target: string; dispatches: DispatchLog[] }[];

// done_at is set once the dispatch has its work item; started_at once a dispatch run was started for it.
const state = (d: DispatchLog) => (d.doneAt ? <Badge variant="positive">Done</Badge> : d.startedAt ? <Badge>Run started</Badge> : <Badge>Waiting</Badge>);

export default function DispatchesPage() {
  const q = useQuery({
    queryKey: ["dispatches"],
    queryFn: async () => {
      const r = await api("/api/dispatches");
      if (!r.ok) throw new Error(`The dispatches answered ${r.status}`);
      return (await r.json()) as Targets;
    },
  });
  const shown = q.data?.filter((t) => t.dispatches.length) ?? [];
  return (
    <main>
      <PageTitle title="Dispatches">Outside systems ask the factory to open a work item about a problem. The last 50 per target, newest first.</PageTitle>
      {q.error && <LoadError what="the dispatches" query={q} className="mb-6" />}
      {q.data && !shown.length && <p className="text-muted-foreground">No dispatches yet.</p>}
      <div className="flex flex-col gap-8">
        {shown.map(({ target, dispatches }) => (
          <section key={target}>
            <SectionHeading>
              <span className="font-mono">{target}</span>
            </SectionHeading>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Source</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Asks for</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Work item</TableHead>
                  <TableHead className="text-right">When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dispatches.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="font-mono text-xs">{d.source}</TableCell>
                    <TableCell className="max-w-48 truncate font-mono text-xs" title={d.key}>
                      {d.key}
                    </TableCell>
                    <TableCell className="max-w-96 truncate" title={d.title}>
                      {d.link ? (
                        <a href={d.link} className="hover:underline">
                          {d.title}
                        </a>
                      ) : (
                        d.title
                      )}
                    </TableCell>
                    <TableCell>{state(d)}</TableCell>
                    <TableCell>
                      {d.workItem ? (
                        <a href={d.workItem} className="font-medium hover:underline">
                          Open
                        </a>
                      ) : (
                        // None yet, or one was open already for the same source and key (and rows from before work_item).
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap text-muted-foreground" title={new Date(d.at).toLocaleString()}>
                      {ago(d.at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
        ))}
      </div>
    </main>
  );
}
