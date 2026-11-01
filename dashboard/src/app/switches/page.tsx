"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SWITCHES, type SwitchName } from "software-factory/run-events";
import { PageTitle } from "@/components/shell";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";

type Rows = Record<string, Record<SwitchName, boolean>>;

const label = (n: string) => n[0].toUpperCase() + n.slice(1).replace(/_/g, " ");

export default function SwitchesPage() {
  const client = useQueryClient();
  const { data, error } = useQuery({
    queryKey: ["switches"],
    queryFn: async () => {
      const r = await api("/api/switches");
      if (!r.ok) throw new Error(`The switches answered ${r.status}`);
      return (await r.json()) as Rows;
    },
  });
  const change = useMutation({
    mutationFn: async (v: { scope: string; name: SwitchName; on: boolean }) => {
      const r = await api("/api/switches", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(v) });
      if (!r.ok) throw new Error(await r.text());
    },
    onSettled: () => client.invalidateQueries({ queryKey: ["switches"] }),
  });
  const failure = error ?? change.error;
  return (
    <main>
      <PageTitle title="Switches">A switch with no saved value is on. A target is off when the all-targets row is off. Current steps finish when you turn a switch off.</PageTitle>
      {failure && (
        <p role="alert" className="mb-6 text-destructive">
          {failure.message}
        </p>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="sticky left-0 bg-background">Scope</TableHead>
            {SWITCHES.map((n) => (
              <TableHead key={n} className="text-center">
                {label(n)}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Object.entries(data ?? {}).map(([scope, row]) => (
            <TableRow key={scope}>
              <TableCell className="sticky left-0 bg-background pr-6 font-medium">{scope === "*" ? "All targets" : <span className="font-mono">{scope}</span>}</TableCell>
              {SWITCHES.map((name) => (
                <TableCell key={name} className="text-center">
                  <Switch aria-label={`${name} for ${scope}`} checked={row[name]} disabled={change.isPending} onCheckedChange={(on) => change.mutate({ scope, name, on })} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </main>
  );
}
