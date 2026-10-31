"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { HostStat, LogLine, LogSource } from "@/server/grafana";

type Part<T> = T | { error: string };
interface Runner {
  jobs: Part<{ job: string; name: string; pipeline: string; startedAt: string; runner?: string }[]>;
  hosts: Part<HostStat[]>;
  logs: Part<LogLine[]>;
}

const SOURCES: LogSource[] = ["docker", "gitlab-runner", "system"];
const pct = (n: number) => (Number.isFinite(n) ? `${Math.round(n)}%` : "?");

// A part that failed shows its error; the other parts still show.
function Show<T>({ part, children }: { part: Part<T> | undefined; children: (v: T) => React.ReactNode }) {
  if (part === undefined) return null;
  if (part && typeof part === "object" && "error" in part) return <p role="alert" className="text-sm text-red-600">{part.error}</p>;
  return <>{children(part as T)}</>;
}

export function RunnerView() {
  const [source, setSource] = useState<LogSource>("docker");
  const [host, setHost] = useState("");
  const { data, error } = useQuery({
    queryKey: ["runner", source, host],
    refetchInterval: 15_000,
    queryFn: async () => {
      const r = await fetch(`/api/runner?${new URLSearchParams({ source, host, minutes: "15" })}`);
      if (!r.ok) throw new Error(`The runner view answered ${r.status}`);
      return (await r.json()) as Runner;
    },
  });
  return (
    <div className="space-y-6">
      {error && <p role="alert" className="text-red-600">{error.message}</p>}
      <section>
        <h2 className="mb-2 text-lg font-semibold">Running jobs</h2>
        <Show part={data?.jobs}>
          {(jobs) =>
            jobs.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Job</TableHead>
                    <TableHead>Pipeline</TableHead>
                    <TableHead>Runner</TableHead>
                    <TableHead>Started</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {jobs.map((j) => (
                    <TableRow key={j.job}>
                      <TableCell>{j.name}</TableCell>
                      <TableCell>{j.pipeline}</TableCell>
                      <TableCell>{j.runner ?? ""}</TableCell>
                      <TableCell>{new Date(j.startedAt).toLocaleTimeString()}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-sm text-muted-foreground">No job is running.</p>
            )
          }
        </Show>
      </section>
      <section>
        <h2 className="mb-2 text-lg font-semibold">Disk and memory</h2>
        <Show part={data?.hosts}>
          {(hosts) => (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Host</TableHead>
                  <TableHead>Disk used</TableHead>
                  <TableHead>Memory used</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {hosts.map((h) => (
                  <TableRow key={h.host}>
                    <TableCell>
                      <button type="button" className="underline" onClick={() => setHost(h.host === host ? "" : h.host)}>
                        {h.host}
                      </button>
                    </TableCell>
                    <TableCell>{pct(h.diskUsedPct)}</TableCell>
                    <TableCell>{pct(h.memUsedPct)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Show>
      </section>
      <section>
        <h2 className="mb-2 text-lg font-semibold">Logs of the last 15 minutes{host ? ` on ${host}` : ""}</h2>
        <Tabs value={source} onValueChange={(v) => setSource(v as LogSource)} className="mb-2">
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
            <pre className="max-h-[60vh] overflow-auto rounded border p-2 text-xs">
              {logs.map((l) => `${l.at} ${l.host} ${l.line}`).join("\n") || "No log lines."}
            </pre>
          )}
        </Show>
      </section>
    </div>
  );
}
