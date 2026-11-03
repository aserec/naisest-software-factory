"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { HostStat, LogLine, LogSource } from "@/server/grafana";
import { api } from "@/lib/api";
import { ago } from "@/lib/utils";
import { SectionHeading } from "./shell";

type Part<T> = T | { error: string };
interface Runner {
  jobs: Part<{ job: string; name: string; pipeline: string; startedAt: string; runner?: string }[]>;
  hosts: Part<HostStat[]>;
  logs: Part<LogLine[]>;
}

const SOURCES: LogSource[] = ["docker", "gitlab-runner", "system"];
const FULL = 85; // used percent from which a disk or memory bar turns red
const pct = (n: number) => (Number.isFinite(n) ? `${Math.round(n)}%` : "—");
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

// A part that failed shows its error; the other parts still show.
function Show<T>({ part, children }: { part: Part<T> | undefined; children: (v: T) => React.ReactNode }) {
  if (part === undefined) return null;
  if (part && typeof part === "object" && "error" in part)
    return (
      <p role="alert" className="text-destructive">
        {part.error}
      </p>
    );
  return <>{children(part as T)}</>;
}

// A used share at its true ratio: the data hue, red from FULL.
function Used({ label, value }: { label: string; value: number }) {
  const known = Number.isFinite(value);
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)_2.5rem] items-center gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="h-1.5 rounded-full bg-raised">
        {known && <span className={`block h-full rounded-full ${value >= FULL ? "bg-destructive" : "bg-data"}`} style={{ width: `${Math.min(value, 100)}%` }} />}
      </span>
      <span className={`text-right ${known && value >= FULL ? "text-destructive" : ""}`}>{pct(value)}</span>
    </div>
  );
}

export function RunnerView() {
  const [source, setSource] = useState<LogSource>("docker");
  const [host, setHost] = useState("");
  const { data, error } = useQuery({
    queryKey: ["runner", source, host],
    refetchInterval: 15_000,
    queryFn: async () => {
      const r = await api(`/api/runner?${new URLSearchParams({ source, host, minutes: "15" })}`);
      if (!r.ok) throw new Error(`The runner view answered ${r.status}`);
      return (await r.json()) as Runner;
    },
  });
  return (
    <div className="flex flex-col gap-8">
      {error && (
        <p role="alert" className="text-destructive">
          {error.message}
        </p>
      )}
      <div className="grid items-start gap-x-12 gap-y-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section>
          <SectionHeading>Running jobs</SectionHeading>
          <Show part={data?.jobs}>
            {(jobs) =>
              jobs.length ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Job</TableHead>
                      <TableHead>Runner</TableHead>
                      <TableHead className="text-right">Started</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {jobs.map((j) => (
                      <TableRow key={j.job}>
                        <TableCell className="py-2.5">
                          <div className="font-medium">{j.name}</div>
                          <div className="font-mono text-xs text-muted-foreground">
                            job {j.job} · pipeline {j.pipeline}
                          </div>
                        </TableCell>
                        <TableCell className={j.runner ? "" : "text-muted-foreground"}>{j.runner ?? "—"}</TableCell>
                        <TableCell className="text-right">
                          <div>{time(j.startedAt)}</div>
                          <div className="text-xs text-muted-foreground">{ago(j.startedAt)}</div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-muted-foreground">No job is running.</p>
              )
            }
          </Show>
        </section>

        <section>
          <SectionHeading>Hosts</SectionHeading>
          <Show part={data?.hosts}>
            {(hosts) =>
              hosts.length ? (
                <ul>
                  {hosts.map((h) => (
                    <li key={h.host} className="border-b border-rule py-3 first:pt-0 last:border-0">
                      <button
                        type="button"
                        aria-pressed={h.host === host}
                        onClick={() => setHost(h.host === host ? "" : h.host)}
                        className="mb-2 rounded-sm font-medium hover:underline aria-pressed:underline"
                        title={h.host === host ? "Show logs of every host" : `Show only the logs of ${h.host}`}
                      >
                        {h.host}
                      </button>
                      <div className="flex flex-col gap-1.5">
                        <Used label="Disk" value={h.diskUsedPct} />
                        <Used label="Memory" value={h.memUsedPct} />
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground">No runner host reports.</p>
              )
            }
          </Show>
        </section>
      </div>

      <section>
        <SectionHeading className="mb-1 flex-wrap justify-between border-0 pb-0">
          Logs of the last 15 minutes{host ? ` on ${host}` : ""}
          {host && (
            <button type="button" className="text-sm font-normal text-muted-foreground hover:text-foreground" onClick={() => setHost("")}>
              Show every host
            </button>
          )}
        </SectionHeading>
        <Tabs value={source} onValueChange={(v) => setSource(v as LogSource)} className="mb-4">
          <TabsList>
            {SOURCES.map((s) => (
              <TabsTrigger key={s} value={s}>
                {s}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Show part={data?.logs}>
          {(logs) => (
            <pre className="max-h-[60vh] overflow-auto rounded-lg bg-raised p-4 font-mono text-xs leading-5">
              {logs.map((l) => `${time(l.at)}  ${l.host}  ${l.line}`).join("\n") || "No log lines."}
            </pre>
          )}
        </Show>
      </section>
    </div>
  );
}
