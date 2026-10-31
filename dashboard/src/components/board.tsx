"use client";

import { useQuery } from "@tanstack/react-query";
import { type ColumnDef, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";

// One column per state label. Keep in step with STATES in server/gitlab.ts.
export const STATES = ["ready", "running", "waiting", "needs_info", "needs_approval", "done", "stopped", "blocked"].map((s) => `factory_${s}`);

export interface BoardItem {
  target: string;
  ticket: string;
  title: string;
  state: string;
  url: string;
  updatedAt: string;
  run?: string;
  costUsd?: number;
  stuck: boolean;
}

const columns: ColumnDef<BoardItem>[] = [
  {
    id: "item",
    cell: ({ row: { original: i } }) => (
      <>
        {i.run ? (
          <Link href={`/runs/${encodeURIComponent(i.run)}`} className="font-medium underline">
            {i.title}
          </Link>
        ) : (
          <a href={i.url} className="font-medium underline">
            {i.title}
          </a>
        )}
        <div className="text-xs text-muted-foreground">
          {i.target} #{i.ticket}
        </div>
      </>
    ),
  },
  {
    id: "mark",
    cell: ({ row: { original: i } }) => (
      <div className="text-right">
        {i.stuck && <Badge variant="destructive">Stuck</Badge>}
        {i.costUsd !== undefined && <div className="text-xs text-muted-foreground">${i.costUsd.toFixed(2)}</div>}
      </div>
    ),
  },
];

function Column({ state, items }: { state: string; items: BoardItem[] }) {
  const table = useReactTable({ data: items, columns, getCoreRowModel: getCoreRowModel() });
  return (
    <Card>
      <CardHeader>
        <h2 className="font-semibold">
          {state.replace(/^factory_/, "").replace(/_/g, " ")} <span className="text-muted-foreground">({items.length})</span>
        </h2>
      </CardHeader>
      <CardContent>
        <Table>
          <TableBody>
            {table.getRowModel().rows.map((row) => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function Board() {
  const { data, error } = useQuery({
    queryKey: ["board"],
    refetchInterval: 15_000,
    queryFn: async () => {
      const r = await fetch("/api/board");
      if (!r.ok) throw new Error(`The board answered ${r.status}`);
      return (await r.json()) as BoardItem[];
    },
  });
  return (
    <>
      {error && <p role="alert" className="mb-4 text-red-600">{error.message}</p>}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] items-start gap-4">
        {STATES.map((s) => (
          <Column key={s} state={s} items={(data ?? []).filter((i) => i.state === s)} />
        ))}
      </div>
    </>
  );
}
