"use client";

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { eventsOfType, type EventData, type EventOf, type RunEvent } from "software-factory/run-events";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { capitalize, clock, duration, httpUrl, usd } from "@/lib/utils";
import type { FileLink } from "@/server/compose";
import { count, Unpriced, usageByModel } from "./cost-by-model";
import { LoadError, SectionHeading } from "./shell";
import { pre, ToolCalls } from "./tool-calls";
import { useT } from "./use-preferences";


// A step that ran without CI (local-run.sh, the worker) sends its output with its step_end event instead.
function JobLog({ job, end, log }: { job?: string; end?: EventOf<"step_end">; log: UseQueryResult<string> }) {
  const t = useT();
  let { data } = log;
  const note = (text: string) => <p className="text-muted-foreground">{t(text)}</p>;
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
  const cls = "font-mono text-xs break-all text-foreground";
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
  const t = useT();
  const v = VERDICT[outcome.kind] ?? VERDICT.stop;
  return (
    <section aria-label={t("Final decision")} className={`rounded-lg border px-4 py-3 ${v.box} ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <h2 className={`font-medium text-pretty ${v.ink}`}>{outcome.title}</h2>
        <Badge variant={v.badge}>{t(v.label)}</Badge>
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
  const errors = eventsOfType(events, "error").map((e) => e.data.message);
  const { rows: byModel, total, unpriced } = usageByModel(usage);
  const prompt = start.data.prompt ?? eventsOfType(events, "prompt")[0]?.data.prompt;
  const t = useT();
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
      {errors.length > 0 && (
        <Section title={t("Error")}>
          <ul className="flex flex-col gap-2">
            {errors.map((m, i) => (
              <li key={i} className={`${pre} border border-destructive/30 bg-destructive/5`}>
                {m}
              </li>
            ))}
          </ul>
        </Section>
      )}
      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-2">
        <Fact label={t("Started")}>{clock(start.at)}</Fact>
        <Fact label={t("Duration")}>{end ? duration((Date.parse(end.at) - Date.parse(start.at)) / 1000) : t("Still running")}</Fact>
        {byModel.length > 0 && (
          <Fact label={t("Model")}>
            {byModel.map((m) => (
              <div key={`${m.role} ${m.model}`}>
                {m.role} · {m.model}
              </div>
            ))}
          </Fact>
        )}
        {usage.length > 0 && (
          <Fact label={t("Tokens")}>
            {t("{in} in · {out} out", { in: count(total.input), out: count(total.output) })}
          </Fact>
        )}
        <Fact label={t("Cost")}>
          {usage.length === 0 ? (
            <span className="text-muted-foreground">{t("None, no model ran in this step")}</span>
          ) : (
            <>
              {usd(total.costUsd)}
              <Unpriced models={unpriced} />
            </>
          )}
        </Fact>
        {start.job && (
          <Fact label={t("CI job")}>
            <span className="font-mono">{start.job}</span>
          </Fact>
        )}
      </dl>

      {decision && (
        <Section title={t("Decision")}>
          <div className={`rounded-lg border px-4 py-3 ${decision.auto ? "border-pill-positive-ink/20 bg-pill-positive" : "border-pill-warning-ink/20 bg-pill-warning"}`}>
            <p className="font-medium">{t(decision.auto ? "The factory merges this change without a person." : "A person must review and merge this change, because:")}</p>
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
                <Fact label={t("Merge risk")}>
                  {t("{risk} of 10", { risk: decision.risk })}
                  {typeof decision.riskMax === "number" && <span className="text-muted-foreground">{t(", the limit is {max}", { max: decision.riskMax })}</span>}
                </Fact>
              )}
              {decision.changeUrl && (
                <Fact label={t("Change")}>
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
        <Section title={t("Review findings")}>
          <p className="mb-4 text-muted-foreground">{t("Each round, the reviewer reads the change. The author fixes the blocking findings, and the next round reads it again.")}</p>
          <div className="flex flex-col gap-4">
            {rounds.map((round) => {
              const mine = findings.filter((f) => f.round === round);
              return (
                <details key={round} open className="group">
                  <summary className="mb-3 cursor-pointer font-medium">
                    {t("Round {round}", { round })} <span className="font-normal text-muted-foreground">{t("{n} of {total} blocking", { n: mine.filter((f) => f.blocking).length, total: mine.length })}</span>
                  </summary>
                  <ul className="flex flex-col gap-3">
                    {mine.map((f, i) => {
                      const { file, text } = splitFinding(f);
                      return (
                        <li key={i} className={`rounded-lg border px-4 py-3 ${f.blocking ? "border-destructive/30 bg-destructive/5" : "border-pill-warning-ink/20 bg-pill-warning"}`}>
                          <div className="flex items-start justify-between gap-3">
                            <span className="min-w-0 font-medium">{f.title}</span>
                            <Badge variant={f.blocking ? "destructive" : "warning"}>{t(f.blocking ? "Blocking" : "Not blocking")}</Badge>
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
        <Section title={t("Gate checks")}>
          <ul className="flex flex-col gap-4">
            {gates.map((g, i) => (
              <li key={i}>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <code className="min-w-0 truncate font-mono text-xs">{g.command}</code>
                  <Badge variant={g.exitCode ? "destructive" : "positive"}>{t("exit {code}", { code: g.exitCode })}</Badge>
                </div>
                <pre className={`${pre} max-h-60 overflow-y-auto`}>{g.outputTail}</pre>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {rules.length > 0 && (
        <Section title={t("Rule checks")}>
          <ul className="flex flex-col gap-2">
            {rules.map((r, i) => (
              <li key={i} className="grid grid-cols-[4rem_minmax(0,1fr)] items-baseline gap-3">
                <Badge variant={r.passed ? "positive" : "destructive"}>{t(r.passed ? "passed" : "failed")}</Badge>
                <span>
                  <span className="font-mono text-xs">{r.rule}</span> <span className="text-muted-foreground">{r.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {answers.length > 0 && (
        <Section title={t("Jev answers")}>
          <dl className="flex flex-col gap-3">
            {answers.map((a, i) => (
              <div key={i}>
                <dt>{a.question}</dt>
                <dd className="text-muted-foreground">
                  {t("{answer} · {confidence} confidence", { answer: a.answer, confidence: a.confidence })}
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
              {t("Tool calls")} <span className="font-normal text-muted-foreground">{tools.length}</span>
            </>
          }
        >
          <ToolCalls tools={tools} />
        </Section>
      )}

      {prompt && (
        <Section title={t("Prompt")}>
          <pre className={pre}>{prompt}</pre>
        </Section>
      )}

      {/* The decision's log repeats the reasons above, so it starts closed. */}
      {decision ? (
        <details>
          <summary className="cursor-pointer text-muted-foreground">{t(start.job ? "Job log" : "Log")}</summary>
          <div className="mt-3">
            <JobLog job={start.job} end={end} log={log} />
          </div>
        </details>
      ) : (
        <Section title={t(start.job ? "Job log" : "Log")}>
          <JobLog job={start.job} end={end} log={log} />
        </Section>
      )}
    </div>
  );
}
