"use client";

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { eventsOfType, type EventData, type EventOf, type RunEvent } from "software-factory/run-events";
import { Bot, FilePen, FileText, FolderSearch, Globe, ListTodo, type LucideIcon, Search, SquareTerminal, Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { capitalize, duration, httpUrl, usd } from "@/lib/utils";
import type { FileLink } from "@/server/compose";
import { LoadError, SectionHeading } from "./shell";

const count = (n: number) => n.toLocaleString("en");
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const pre = "rounded-md bg-raised p-3 font-mono text-xs leading-5 whitespace-pre-wrap break-words";

// A step that ran without CI (local-run.sh, the worker) sends its output with its step_end event instead.
function JobLog({ job, end, log }: { job?: string; end?: EventOf<"step_end">; log: UseQueryResult<string> }) {
  let { data } = log;
  const note = (text: string) => <p className="text-muted-foreground">{text}</p>;
  if (!job) {
    if (!end) return note("The log shows when the step ends.");
    if (typeof end.data.log !== "string") return note("This step has no CI job and sent no log.");
    data = end.data.log;
  } else if (log.error) return <LoadError what="the job log" query={log} />;
  else if (log.isLoading) return note("Loading the job log…");
  return <pre className={pre}>{data}</pre>;
}

const Section = ({ title, children }: { title: React.ReactNode; children: React.ReactNode }) => (
  <section>
    <SectionHeading as="h3">{title}</SectionHeading>
    {children}
  </section>
);

// A finding's file: from the event, or for an older event from the "file: " its text starts with.
export function splitFinding(f: { file?: string; text: string }): { file?: string; text: string } {
  const file: string | undefined = f.file ?? f.text.match(/^([\w.@/-]+\.\w+): /)?.[1];
  return { file, text: file && f.text.startsWith(`${file}: `) ? f.text.slice(file.length + 2) : f.text };
}

// The file links into the change's diff once the hash of its path is known; until then, and without a change, it is plain text.
function FileName({ path, link }: { path: string; link?: FileLink }) {
  const [href, setHref] = useState<string>();
  useEffect(() => {
    if (!link || !globalThis.crypto?.subtle) return;
    crypto.subtle.digest(link.hash, new TextEncoder().encode(path)).then((d) => setHref(link.base + [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("")));
  }, [path, link]);
  const cls = "font-mono text-xs break-all text-data";
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className={`${cls} underline underline-offset-4 hover:decoration-2`}>
      {path}
    </a>
  ) : (
    <span className={cls}>{path}</span>
  );
}

// Triage's outcome in one colored box: green builds, amber waits for a person, red stopped.
const VERDICT = {
  go: { box: "border-pill-positive-ink/20 bg-pill-positive", ink: "text-pill-positive-ink", badge: "positive", label: "Go" },
  ask: { box: "border-pill-warning-ink/20 bg-pill-warning", ink: "text-pill-warning-ink", badge: "warning", label: "Waits for a person" },
  stop: { box: "border-pill-negative-ink/20 bg-pill-negative", ink: "text-pill-negative-ink", badge: "destructive", label: "Stop" },
} as const;

export function Verdict({ outcome, className = "" }: { outcome: EventData<"triage_outcome">; className?: string }) {
  const v = VERDICT[outcome.kind] ?? VERDICT.stop;
  return (
    <section aria-label="Final decision" className={`rounded-lg border px-4 py-3 ${v.box} ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <h2 className={`font-medium text-pretty ${v.ink}`}>{outcome.title}</h2>
        <Badge variant={v.badge}>{v.label}</Badge>
      </div>
      <ul className="mt-2 flex flex-col gap-1.5">
        {outcome.reasons.map((r) => (
          <li key={r} className="text-pretty">
            {r}
          </li>
        ))}
      </ul>
      {httpUrl(outcome.url) ? (
        <a href={outcome.url} target="_blank" rel="noreferrer" className="mt-2 inline-block break-all underline underline-offset-4 hover:decoration-2">
          {outcome.url}
        </a>
      ) : (
        outcome.url && <p className="mt-2 break-all">{outcome.url}</p>
      )}
    </section>
  );
}

export const Fact = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <>
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="min-w-0">{children}</dd>
  </>
);

const TOKENS = ["input", "output", "cacheRead", "cacheWrite"] as const;
type Usage = Record<(typeof TOKENS)[number] | "costUsd", number>;

// Usage events summed per role and model, and in all. unpriced: the models with no price in seams.yml; they report tokens and $0.
export function usageByModel(usage: EventData<"usage">[]) {
  const rows = new Map<string, Usage & { role: string; model: string }>();
  const total: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
  for (const u of usage) {
    const key = `${u.role} · ${u.model}`;
    const row = rows.get(key) ?? rows.set(key, { role: u.role, model: u.model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }).get(key)!;
    for (const k of [...TOKENS, "costUsd"] as const) {
      row[k] += u[k];
      total[k] += u[k];
    }
  }
  const unpriced = [...new Set(usage.filter((u) => !u.costUsd && (u.input || u.output)).map((u) => u.model))];
  return { rows: [...rows.values()], total, unpriced };
}

const Unpriced = ({ models }: { models: string[] }) => models.length > 0 && <div className="text-muted-foreground">Without {models.join(" and ")}: seams.yml sets no price for it</div>;

// The whole run's tokens and cost per role and model, for the run page.
export function CostByModel({ usage }: { usage: EventData<"usage">[] }) {
  const { rows, total, unpriced } = usageByModel(usage);
  const num = "py-2 pl-4 text-right whitespace-nowrap";
  const cells = (u: Usage) => (
    <>
      {TOKENS.map((k) => (
        <td key={k} className={num}>
          {count(u[k])}
        </td>
      ))}
      <td className={num}>{usd(u.costUsd)}</td>
    </>
  );
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[36rem]">
          <thead className="text-muted-foreground">
            <tr className="border-b">
              {["Role and model", "Input", "Output", "Cache read", "Cache write", "Cost"].map((h, i) => (
                <th key={h} scope="col" className={i ? `${num} font-normal` : "py-2 text-left font-normal"}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.role} ${r.model}`} className="border-b border-rule">
                <th scope="row" className="py-2 text-left font-normal">
                  {r.role} · <span className="font-mono text-xs">{r.model}</span>
                </th>
                {cells(r)}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-medium">
              <th scope="row" className="py-2 text-left font-medium">
                Total
              </th>
              {cells(total)}
            </tr>
          </tfoot>
        </table>
      </div>
      <Unpriced models={unpriced} />
    </>
  );
}

// An icon per kind of tool. Claude Code names tools "Read", Pi "read", so the name is matched in lower case.
const TOOL_ICON: Record<string, LucideIcon> = { bash: SquareTerminal, read: FileText, edit: FilePen, multiedit: FilePen, write: FilePen, notebookedit: FilePen, grep: Search, glob: FolderSearch, find: FolderSearch, ls: FolderSearch, webfetch: Globe, websearch: Globe, task: Bot, todowrite: ListTodo };
const ToolIcon = ({ name }: { name: string }) => {
  const Icon = TOOL_ICON[name.toLowerCase()] ?? Wrench;
  return <Icon className="size-4 flex-none self-center text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />;
};

// What a call acted on, from its JSON input: a bash command, a file, a pattern. An input cut at MAX_FIELD is no longer JSON, so it shows none.
function toolTarget(input: string): string | undefined {
  try {
    const i = JSON.parse(input) as Record<string, unknown>;
    return [i.command, i.file_path, i.path, i.pattern, i.url, i.query].find((v): v is string => typeof v === "string");
  } catch {}
}

const took = (ms: number) => (!Number.isFinite(ms) || ms < 0 ? undefined : ms < 1000 ? `${Math.round(ms)} ms` : duration(ms / 1000));

function ToolCall({ call }: { call: EventOf<"tool_call"> }) {
  const { name, input, result, ms, ok } = call.data;
  const what = toolTarget(input);
  const time = [took(ms), !ok && "failed"].filter(Boolean).join(", ");
  return (
    <details className="group">
      <summary className="flex w-full cursor-pointer list-none items-baseline gap-2 rounded-md py-1 hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ToolIcon name={name} />
        <span className="flex-none font-medium group-open:underline">{name}</span>
        {what && <code className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{what}</code>}
        {time && <span className={`ml-auto flex-none text-xs ${ok ? "text-muted-foreground" : "text-destructive"}`}>{time}</span>}
      </summary>
      <div className="mt-1 mb-3 flex flex-col gap-2">
        <pre className={pre}>{input}</pre>
        <pre className={pre}>{result}</pre>
      </div>
    </details>
  );
}

// From this many calls of the same tool in a row, they fold into one line, so twenty reads do not push the rest away.
const FOLD = 3;

function ToolCalls({ tools }: { tools: EventOf<"tool_call">[] }) {
  const runs: EventOf<"tool_call">[][] = [];
  for (const t of tools) {
    const last = runs.at(-1);
    if (last?.[0].data.name === t.data.name) last.push(t);
    else runs.push([t]);
  }
  const one = (t: EventOf<"tool_call">) => (
    <li key={t.id}>
      <ToolCall call={t} />
    </li>
  );
  return (
    <ul className="flex flex-col gap-1">
      {runs.map((run) => {
        if (run.length < FOLD) return run.map(one);
        const failed = run.filter((t) => !t.data.ok).length;
        const time = [took(run.reduce((sum, t) => sum + t.data.ms, 0)), failed && `${failed} failed`].filter(Boolean).join(", ");
        return (
          <li key={run[0].id}>
            <details className="group/run">
              <summary className="flex w-full cursor-pointer list-none items-baseline gap-2 rounded-md py-1 hover:text-foreground [&::-webkit-details-marker]:hidden">
                <ToolIcon name={run[0].data.name} />
                <span className="flex-none font-medium group-open/run:underline">{run[0].data.name}</span>
                <span className="text-muted-foreground">{run.length} calls in a row</span>
                <span className={`ml-auto flex-none text-xs ${failed ? "text-destructive" : "text-muted-foreground"}`}>{time}</span>
              </summary>
              <ul className="mt-1 mb-2 flex flex-col gap-1 border-l border-rule pl-4">{run.map(one)}</ul>
            </details>
          </li>
        );
      })}
    </ul>
  );
}

// Everything about one step, for the side panel. It is mounted only while the panel is open, so the CI is asked for the log only then.
export function StepDetail({ start, end, tools = [], events, fileLink }: { start: EventOf<"step_start">; end?: EventOf<"step_end">; tools?: EventOf<"tool_call">[]; events: RunEvent[]; fileLink?: FileLink }) {
  const findings = eventsOfType(events, "review_finding").map((e) => e.data);
  const rounds = [...new Set(findings.map((f) => f.round))].sort((a, b) => a - b);
  const gates = eventsOfType(events, "gate_check").map((e) => e.data);
  const rules = eventsOfType(events, "rule_check").map((e) => e.data);
  const answers = eventsOfType(events, "jev_answer").map((e) => e.data);
  const decision = eventsOfType(events, "decision").map((e) => e.data).at(-1);
  const outcome = eventsOfType(events, "triage_outcome").map((e) => e.data).at(-1);
  const usage = eventsOfType(events, "usage").map((e) => e.data);
  const { rows: byModel, total, unpriced } = usageByModel(usage);
  const prompt = start.data.prompt;
  const log = useQuery({
    queryKey: ["log", start.job],
    enabled: !!start.job,
    queryFn: async () => {
      const r = await api(`/api/jobs/${encodeURIComponent(start.job!)}/log`);
      if (!r.ok) throw new Error(`The job log answered ${r.status}`);
      return r.text();
    },
  });
  return (
    <div className="flex flex-col gap-8">
      {outcome && <Verdict outcome={outcome} />}
      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-2">
        <Fact label="Started">{clock(start.at)}</Fact>
        <Fact label="Duration">{end ? duration((Date.parse(end.at) - Date.parse(start.at)) / 1000) : "Still running"}</Fact>
        {byModel.length > 0 && (
          <Fact label="Model">
            {byModel.map((m) => (
              <div key={`${m.role} ${m.model}`}>
                {m.role} · {m.model}
              </div>
            ))}
          </Fact>
        )}
        {usage.length > 0 && (
          <Fact label="Tokens">
            {count(total.input)} in · {count(total.output)} out
          </Fact>
        )}
        <Fact label="Cost">
          {usage.length === 0 ? (
            <span className="text-muted-foreground">None, no model ran in this step</span>
          ) : (
            <>
              {usd(total.costUsd)}
              <Unpriced models={unpriced} />
            </>
          )}
        </Fact>
        {start.job && (
          <Fact label="CI job">
            <span className="font-mono">{start.job}</span>
          </Fact>
        )}
      </dl>

      {decision && (
        <Section title="Decision">
          <div className={`rounded-lg border px-4 py-3 ${decision.auto ? "border-pill-positive-ink/20 bg-pill-positive" : "border-pill-warning-ink/20 bg-pill-warning"}`}>
            <p className="font-medium">{decision.auto ? "The factory merges this change without a person." : "A person must review and merge this change, because:"}</p>
            {!decision.auto && (
              <ul className="mt-2 list-disc divide-y divide-pill-warning-ink/10 pl-5">
                {decision.reasons.map((r) => (
                  <li key={r} className="py-1.5 text-pretty">
                    {capitalize(r)}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {(typeof decision.risk === "number" || decision.changeUrl) && (
            <dl className="mt-4 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-2">
              {typeof decision.risk === "number" && (
                <Fact label="Merge risk">
                  {decision.risk} of 10{typeof decision.riskMax === "number" && <span className="text-muted-foreground">, the limit is {decision.riskMax}</span>}
                </Fact>
              )}
              {decision.changeUrl && (
                <Fact label="Change">
                  {httpUrl(decision.changeUrl) ? (
                    <a href={decision.changeUrl} target="_blank" rel="noreferrer" className="break-all underline underline-offset-4 hover:decoration-2">
                      {decision.changeUrl}
                    </a>
                  ) : (
                    decision.changeUrl
                  )}
                </Fact>
              )}
            </dl>
          )}
        </Section>
      )}

      {findings.length > 0 && (
        <Section title="Review findings">
          <p className="mb-4 text-muted-foreground">Each round, the reviewer reads the change. The author fixes the blocking findings, and the next round reads it again.</p>
          <div className="flex flex-col gap-4">
            {rounds.map((round) => {
              const mine = findings.filter((f) => f.round === round);
              return (
                <details key={round} open className="group">
                  <summary className="mb-3 cursor-pointer font-medium">
                    Round {round} <span className="font-normal text-muted-foreground">{mine.filter((f) => f.blocking).length} of {mine.length} blocking</span>
                  </summary>
                  <ul className="flex flex-col gap-3">
                    {mine.map((f, i) => {
                      const { file, text } = splitFinding(f);
                      return (
                        <li key={i} className={`rounded-lg border px-4 py-3 ${f.blocking ? "border-destructive/30 bg-destructive/5" : "border-pill-warning-ink/20 bg-pill-warning"}`}>
                          <div className="flex items-start justify-between gap-3">
                            <span className="min-w-0 font-medium">{f.title}</span>
                            <Badge variant={f.blocking ? "destructive" : "warning"}>{f.blocking ? "Blocking" : "Not blocking"}</Badge>
                          </div>
                          {file && (
                            <div className="mt-1">
                              <FileName path={file} link={fileLink} />
                            </div>
                          )}
                          <p className="mt-3 text-pretty">{text}</p>
                        </li>
                      );
                    })}
                  </ul>
                </details>
              );
            })}
          </div>
        </Section>
      )}

      {gates.length > 0 && (
        <Section title="Gate checks">
          <ul className="flex flex-col gap-4">
            {gates.map((g, i) => (
              <li key={i}>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <code className="min-w-0 truncate font-mono text-xs">{g.command}</code>
                  <Badge variant={g.exitCode ? "destructive" : "positive"}>exit {g.exitCode}</Badge>
                </div>
                <pre className={`${pre} max-h-60 overflow-y-auto`}>{g.outputTail}</pre>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {rules.length > 0 && (
        <Section title="Rule checks">
          <ul className="flex flex-col gap-2">
            {rules.map((r, i) => (
              <li key={i} className="grid grid-cols-[4rem_minmax(0,1fr)] items-baseline gap-3">
                <Badge variant={r.passed ? "positive" : "destructive"}>{r.passed ? "passed" : "failed"}</Badge>
                <span>
                  <span className="font-mono text-xs">{r.rule}</span> <span className="text-muted-foreground">{r.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {answers.length > 0 && (
        <Section title="Jev answers">
          <dl className="flex flex-col gap-3">
            {answers.map((a, i) => (
              <div key={i}>
                <dt>{a.question}</dt>
                <dd className="text-muted-foreground">
                  {a.answer} · {a.confidence} confidence
                </dd>
              </div>
            ))}
          </dl>
        </Section>
      )}

      {tools.length > 0 && (
        <Section
          title={
            <>
              Tool calls <span className="font-normal text-muted-foreground">{tools.length}</span>
            </>
          }
        >
          <ToolCalls tools={tools} />
        </Section>
      )}

      {prompt && (
        <Section title="Prompt">
          <pre className={pre}>{prompt}</pre>
        </Section>
      )}

      {/* The decision's log repeats the reasons above, so it starts closed. */}
      {decision ? (
        <details>
          <summary className="cursor-pointer text-muted-foreground">{start.job ? "Job log" : "Log"}</summary>
          <div className="mt-3">
            <JobLog job={start.job} end={end} log={log} />
          </div>
        </details>
      ) : (
        <Section title={start.job ? "Job log" : "Log"}>
          <JobLog job={start.job} end={end} log={log} />
        </Section>
      )}
    </div>
  );
}
