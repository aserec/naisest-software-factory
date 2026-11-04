"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SWITCHES, type SwitchName } from "software-factory/run-events";
import { PageTitle, SectionHeading } from "@/components/shell";
import { Confirm } from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";

type Rows = Record<string, Record<SwitchName, boolean>>;

const label = (n: string) => n[0].toUpperCase() + n.slice(1).replace(/_/g, " ");

// What stops while a switch is off, from docs/how-it-works.md.
const OFF: Record<SwitchName, string> = {
  watcher: "The watcher opens no work items.",
  dispatches: "Dispatches wait and open no work items.",
  new_runs: "No new run starts. Ready work items wait.",
  retry: "No waiting run is resumed on the retry schedule.",
  questions: "A run that would ask questions on the work item stops instead.",
  prepare_patch: "A run stops before the author writes the change.",
  auto_merge: "Every change waits for a person to approve it.",
  apply: "A run stops before it merges.",
  improve: "The weekly job opens no change to the repo's factory instructions.",
};

// The columns in SWITCHES order, under one heading per part of the factory.
const GROUPS: [string, SwitchName[]][] = [
  ["New work items", ["watcher", "dispatches"]],
  ["Runs", ["new_runs", "retry", "questions", "prepare_patch"]],
  ["Merge", ["auto_merge", "apply"]],
  ["Self-improvement", ["improve"]],
];

// Turning these on lets the factory merge, so the page asks first.
const ASK_ON: Partial<Record<SwitchName, string>> = {
  auto_merge: "Low-risk changes whose checks pass merge without a person.",
  apply: "The factory merges again. Runs this switch stopped continue and merge their change.",
};

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
  const [ask, setAsk] = useState<{ scope: string; name: SwitchName }>();
  const where = (scope: string) => (scope === "*" ? "all targets" : scope);
  const cell = (scope: string, name: SwitchName, on: boolean) => {
    if (scope !== "*" && data?.["*"]?.[name] === false) return <span className="whitespace-nowrap text-muted-foreground">Off (all targets)</span>;
    const pending = change.isPending && change.variables?.scope === scope && change.variables.name === name;
    return <Switch aria-label={`${label(name)} for ${where(scope)}`} checked={on} disabled={pending} onCheckedChange={(v) => (v && ASK_ON[name] ? setAsk({ scope, name }) : change.mutate({ scope, name, on: v }))} />;
  };
  return (
    <main>
      <PageTitle title="Switches">A switch with no saved value is on. A target is off when the all-targets row is off. Current steps finish when you turn a switch off.</PageTitle>
      {failure && (
        <p role="alert" className="mb-6 text-destructive">
          {failure.message}
        </p>
      )}
      <p className="mb-2 text-muted-foreground md:hidden">Scroll the table sideways for all {SWITCHES.length} switches.</p>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="sticky left-0 bg-background" />
            {GROUPS.map(([group, names]) => (
              <TableHead key={group} colSpan={names.length} className="border-l text-center font-medium text-foreground">
                {group}
              </TableHead>
            ))}
          </TableRow>
          <TableRow>
            <TableHead className="sticky left-0 bg-background">Scope</TableHead>
            {GROUPS.flatMap(([, names]) =>
              names.map((n, i) => (
                <TableHead key={n} className={`text-center font-normal text-muted-foreground ${i === 0 ? "border-l" : ""}`}>
                  {label(n)}
                </TableHead>
              )),
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Object.entries(data ?? {}).map(([scope, row]) => (
            <TableRow key={scope}>
              <TableCell className="sticky left-0 bg-background pr-6 font-medium">{scope === "*" ? "All targets" : <span className="font-mono">{scope}</span>}</TableCell>
              {GROUPS.flatMap(([, names]) =>
                names.map((name, i) => (
                  <TableCell key={name} className={`text-center ${i === 0 ? "border-l" : ""}`}>
                    {cell(scope, name, row[name])}
                  </TableCell>
                )),
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Confirm
        open={!!ask}
        onOpenChange={(o) => !o && setAsk(undefined)}
        title={ask ? `Turn on ${label(ask.name)} for ${where(ask.scope)}?` : ""}
        description={ask ? ASK_ON[ask.name]! : ""}
        action="Turn on"
        onConfirm={() => ask && change.mutate({ ...ask, on: true })}
      />
      <section className="mt-8 max-w-2xl">
        <SectionHeading>When a switch is off</SectionHeading>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
          {GROUPS.flatMap(([, names]) => names).map((n) => (
            <div key={n} className="contents">
              <dt className="font-medium">{label(n)}</dt>
              <dd className="text-muted-foreground">{OFF[n]}</dd>
            </div>
          ))}
        </dl>
      </section>
    </main>
  );
}
