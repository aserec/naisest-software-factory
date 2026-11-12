"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SWITCHES, type SwitchName } from "software-factory/run-events";
import { LoadError, PageTitle, SectionHeading } from "@/components/shell";
import { useT } from "@/components/use-preferences";
import { Confirm } from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { ago, words } from "@/lib/utils";
import type { SwitchChange } from "@/server/db";

type Rows = Record<string, Record<SwitchName, boolean>>;

// The glossary's words: "retry" resumes waiting runs, and the glossary avoids "retry" for that.
const NAMES: Partial<Record<SwitchName, string>> = { retry: "Auto-resume", auto_merge: "Auto-merge", merge_all: "Merge all" };
const englishLabel = (n: SwitchName) => NAMES[n] ?? words(n);

// What stops while a switch is off, from docs/how-it-works.md.
const OFF: Record<SwitchName, string> = {
  watcher: "The watcher opens no work items.",
  dispatches: "Dispatches wait and open no work items.",
  new_runs: "No new run starts. Ready work items wait.",
  retry: "A run waiting at the usage limit does not resume on its own.",
  questions: "A run that would ask questions on the work item stops instead.",
  prepare_patch: "A run stops before the author writes the change.",
  auto_merge: "Every change waits for a person to approve it.",
  merge_all: "Only low-risk changes whose checks pass merge alone. Off until a person turns it on.",
  apply: "A run stops before it merges.",
  improve: "The weekly job opens no change to the repo's factory instructions.",
};

// The heading each switch's column sits under. A Record, so a new switch without a heading fails to compile.
const GROUP: Record<SwitchName, string> = {
  watcher: "New work items",
  dispatches: "New work items",
  new_runs: "Runs",
  retry: "Runs",
  questions: "Runs",
  prepare_patch: "Runs",
  auto_merge: "Merge",
  merge_all: "Merge",
  apply: "Merge",
  improve: "Self-improvement",
};
// The columns in SWITCHES order, under one heading per part of the factory.
const GROUPS = [...SWITCHES.reduce((m, n) => m.set(GROUP[n], [...(m.get(GROUP[n]) ?? []), n]), new Map<string, SwitchName[]>())];

// Turning these on lets the factory merge, so the page asks first.
const ASK_ON: Partial<Record<SwitchName, string>> = {
  auto_merge: "Low-risk changes whose checks pass merge without a person.",
  merge_all: "Every change the factory opens merges without a person, whatever its risk, unless it holds a secret or a person asked for changes. Auto-merge and Apply must be on too.",
  apply: "The factory merges again. Runs this switch stopped continue and merge their change.",
};

export default function SwitchesPage() {
  const t = useT();
  const label = (n: SwitchName) => t(englishLabel(n));
  const client = useQueryClient();
  const switches = useQuery({
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
      // 403: the server's sentence says which role is missing.
      if (!r.ok) throw new Error(`${t(v.on ? "Could not turn {name} on for {where}." : "Could not turn {name} off for {where}.", { name: label(v.name), where: where(v.scope) })} ${r.status === 403 ? await r.text() : t("Try again.")}`);
    },
    onSettled: () => client.invalidateQueries({ queryKey: ["switches"] }), // the prefix also reloads the history
  });
  const history = useQuery({
    queryKey: ["switches", "history"],
    queryFn: async () => {
      const r = await api("/api/switches/history");
      if (!r.ok) throw new Error(`The switch history answered ${r.status}`);
      return (await r.json()) as SwitchChange[];
    },
  });
  const { data, error } = switches;
  const [ask, setAsk] = useState<{ scope: string; name: SwitchName }>();
  const where = (scope: string) => (scope === "*" ? t("all targets") : scope);
  const cell = (scope: string, name: SwitchName, on: boolean) => {
    if (scope !== "*" && data?.["*"]?.[name] === false) return <span className="whitespace-nowrap text-muted-foreground">{t("Off (all targets)")}</span>;
    const pending = change.isPending && change.variables?.scope === scope && change.variables.name === name;
    return <Switch aria-label={t("{name} for {where}", { name: label(name), where: where(scope) })} checked={on} disabled={pending} onCheckedChange={(v) => (v && ASK_ON[name] ? setAsk({ scope, name }) : change.mutate({ scope, name, on: v }))} />;
  };
  return (
    <main>
      <PageTitle title={t("Switches")}>{t("A switch with no saved value is on, except Merge all. A target is off when the all-targets row is off. Current steps finish when you turn a switch off.")}</PageTitle>
      {error && <LoadError what="the switches" query={switches} className="mb-6" />}
      {change.error && (
        <p role="alert" className="mb-6 text-destructive">
          {change.error.message}
        </p>
      )}
      <p className="mb-2 text-muted-foreground md:hidden">{t("Scroll the table sideways for all {count} switches.", { count: SWITCHES.length })}</p>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="sticky left-0 bg-background" />
            {GROUPS.map(([group, names]) => (
              <TableHead key={group} colSpan={names.length} className="border-l text-center font-medium text-foreground">
                {t(group)}
              </TableHead>
            ))}
          </TableRow>
          <TableRow>
            <TableHead className="sticky left-0 bg-background">{t("Scope")}</TableHead>
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
              <TableCell className="sticky left-0 bg-background pr-6 font-medium">{scope === "*" ? t("All targets") : <span className="font-mono">{scope}</span>}</TableCell>
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
        title={ask ? t("Turn on {name} for {where}?", { name: label(ask.name), where: where(ask.scope) }) : ""}
        description={ask ? t(ASK_ON[ask.name]!) : ""}
        action={t("Turn on")}
        onConfirm={() => ask && change.mutate({ ...ask, on: true })}
      />
      <section className="mt-8">
        <SectionHeading>{t("History")}</SectionHeading>
        {history.error && <LoadError what="the switch history" query={history} />}
        {history.data?.length === 0 && <p className="text-muted-foreground">{t("No switch was changed yet.")}</p>}
        {!!history.data?.length && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("Who")}</TableHead>
                <TableHead>{t("Switch")}</TableHead>
                <TableHead>{t("Target")}</TableHead>
                <TableHead>{t("Turned")}</TableHead>
                <TableHead className="text-right">{t("When")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.data.map((c, i) => (
                <TableRow key={`${c.at}-${i}`}>
                  <TableCell>{c.user}</TableCell>
                  <TableCell>{label(c.name)}</TableCell>
                  <TableCell>{c.scope === "*" ? t("All targets") : <span className="font-mono">{c.scope}</span>}</TableCell>
                  <TableCell>{c.on ? t("On") : t("Off")}</TableCell>
                  <TableCell className="text-right text-muted-foreground" title={new Date(c.at).toLocaleString()}>
                    {ago(c.at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {history.data?.length === 50 && <p className="mt-2 text-muted-foreground">{t("The last 50 changes.")}</p>}
      </section>
      <section className="mt-8 max-w-2xl">
        <SectionHeading>{t("When a switch is off")}</SectionHeading>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
          {GROUPS.flatMap(([, names]) => names).map((n) => (
            <div key={n} className="contents">
              <dt className="font-medium">{label(n)}</dt>
              <dd className="text-muted-foreground">{t(OFF[n])}</dd>
            </div>
          ))}
        </dl>
      </section>
    </main>
  );
}
