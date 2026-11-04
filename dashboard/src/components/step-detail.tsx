"use client";

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import type { RunEvent } from "software-factory/run-events";
import { Badge } from "@/components/ui/badge";
import { duration, usd } from "@/lib/utils";
import { LoadError, SectionHeading } from "./shell";

const ofType = (events: RunEvent[], type: RunEvent["type"]) => events.filter((e) => e.type === type).map((e) => e.data as Record<string, any>);
const count = (n: number) => n.toLocaleString("en");
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const pre = "rounded-md bg-raised p-3 font-mono text-xs leading-5 whitespace-pre-wrap break-words";

// A step that ran without CI (local-run.sh, the worker) sends its output with its step_end event instead.
function JobLog({ job, end, log }: { job?: string; end?: RunEvent; log: UseQueryResult<string> }) {
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

export const Fact = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <>
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="min-w-0">{children}</dd>
  </>
);

// Everything about one step, for the side panel. It is mounted only while the panel is open, so the CI is asked for the log only then.
export function StepDetail({ start, end, tools = [], events }: { start: RunEvent; end?: RunEvent; tools?: RunEvent[]; events: RunEvent[] }) {
  const findings = ofType(events, "review_finding");
  const gates = ofType(events, "gate_check");
  const rules = ofType(events, "rule_check");
  const answers = ofType(events, "jev_answer");
  const usage = ofType(events, "usage");
  const cost = usage.reduce((sum, u) => sum + (u.costUsd as number), 0);
  const models = [...new Set(usage.map((u) => `${u.role} · ${u.model}`))];
  const tokens = (k: string) => usage.reduce((sum, u) => sum + ((u[k] as number) ?? 0), 0);
  const prompt = start.data.prompt as string | undefined;
  const log = useQuery({
    queryKey: ["log", start.job],
    enabled: !!start.job,
    queryFn: async () => {
      const r = await fetch(`/api/jobs/${encodeURIComponent(start.job!)}/log`);
      if (!r.ok) throw new Error(`The job log answered ${r.status}`);
      return r.text();
    },
  });
  return (
    <div className="flex flex-col gap-8">
      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-2">
        <Fact label="Started">{clock(start.at)}</Fact>
        <Fact label="Duration">{end ? duration((Date.parse(end.at) - Date.parse(start.at)) / 1000) : "Still running"}</Fact>
        {models.length > 0 && <Fact label="Model">{models.join(", ")}</Fact>}
        {usage.length > 0 && (
          <Fact label="Tokens">
            {count(tokens("input"))} in · {count(tokens("output"))} out
          </Fact>
        )}
        <Fact label="Cost">{usd(cost)}</Fact>
        {start.job && (
          <Fact label="CI job">
            <span className="font-mono">{start.job}</span>
          </Fact>
        )}
      </dl>

      {findings.length > 0 && (
        <Section title="Review findings">
          <ul className="flex flex-col gap-3">
            {findings.map((f, i) => (
              <li key={i} className="flex items-start gap-3">
                <Badge variant="secondary" className="mt-0.5">
                  Round {f.round}
                </Badge>
                <span className="min-w-0 flex-1">{f.text}</span>
                {f.blocking && (
                  <Badge variant="destructive" className="mt-0.5">
                    Blocking
                  </Badge>
                )}
              </li>
            ))}
          </ul>
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
          <ul className="flex flex-col gap-1">
            {tools.map((t) => (
              <li key={t.id}>
                <details className="group">
                  <summary className="flex w-full items-baseline justify-between gap-3 rounded-md py-1 hover:text-foreground [&::-webkit-details-marker]:hidden">
                    <span className="font-medium group-open:underline">{t.data.name as string}</span>
                    <span className={`text-xs ${t.data.ok ? "text-muted-foreground" : "text-destructive"}`}>
                      {t.data.ms as number} ms{t.data.ok ? "" : ", failed"}
                    </span>
                  </summary>
                  <div className="mt-1 mb-3 flex flex-col gap-2">
                    <pre className={pre}>{t.data.input as string}</pre>
                    <pre className={pre}>{t.data.result as string}</pre>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {prompt && (
        <Section title="Prompt">
          <pre className={pre}>{prompt}</pre>
        </Section>
      )}

      <Section title={start.job ? "Job log" : "Log"}>
        <JobLog job={start.job} end={end} log={log} />
      </Section>
    </div>
  );
}
