"use client";

import { useQuery } from "@tanstack/react-query";
import type { RunEvent } from "software-factory/run-events";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const ofType = (events: RunEvent[], type: RunEvent["type"]) => events.filter((e) => e.type === type).map((e) => e.data as Record<string, any>);

function JobLog({ job, log: { data, error, isLoading } }: { job?: string; log: { data?: string; error: Error | null; isLoading: boolean } }) {
  if (!job) return <p>This step has no CI job.</p>;
  if (error) return <p role="alert">{error.message}</p>;
  if (isLoading) return <p>Loading the job log...</p>;
  return (
    <ScrollArea className="h-80 rounded-lg bg-raised">
      <pre className="p-4 font-mono text-xs leading-5">{data}</pre>
    </ScrollArea>
  );
}

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="mb-5">
    <h3 className="mb-1.5 font-semibold">{title}</h3>
    {children}
  </section>
);

function Panel({ start, events }: { start: RunEvent; events: RunEvent[] }) {
  const findings = ofType(events, "review_finding");
  const gates = ofType(events, "gate_check");
  const rules = ofType(events, "rule_check");
  const answers = ofType(events, "jev_answer");
  const cost = ofType(events, "usage").reduce((sum, u) => sum + (u.costUsd as number), 0);
  const prompt = start.data.prompt as string | undefined;
  // The Panel is mounted only while the dialog is open, so GitLab is asked only then.
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
    <Tabs defaultValue="summary" className="min-w-0">
      <TabsList>
        <TabsTrigger value="summary">Summary</TabsTrigger>
        <TabsTrigger value="log">Job log</TabsTrigger>
      </TabsList>
      <TabsContent value="summary">
        <ScrollArea className="h-96">
          {prompt && (
            <Section title="Prompt">
              <pre className="rounded-md bg-raised p-3 font-mono text-xs whitespace-pre-wrap">{prompt}</pre>
            </Section>
          )}
          <Section title="Findings">
            {findings.length === 0 && <p className="text-muted-foreground">None</p>}
            {findings.map((f, i) => (
              <p key={i}>
                Round {f.round}: {f.text} {f.blocking && <Badge variant="destructive">Blocking</Badge>}
              </p>
            ))}
          </Section>
          <Section title="Gate checks">
            {gates.length === 0 && <p className="text-muted-foreground">None</p>}
            {gates.map((g, i) => (
              <div key={i} className="mb-2">
                <code className="font-mono">{g.command}</code> <span className={g.exitCode ? "text-destructive" : "text-muted-foreground"}>exit {g.exitCode}</span>
                <pre className="mt-1 rounded-md bg-raised p-3 font-mono text-xs whitespace-pre-wrap">{g.outputTail}</pre>
              </div>
            ))}
          </Section>
          <Section title="Rule checks">
            {rules.length === 0 && <p className="text-muted-foreground">None</p>}
            {rules.map((r, i) => (
              <p key={i}>
                {r.rule}: {r.passed ? "passed" : "failed"} ({r.detail})
              </p>
            ))}
          </Section>
          <Section title="Jev answers">
            {answers.length === 0 && <p className="text-muted-foreground">None</p>}
            {answers.map((a, i) => (
              <p key={i}>
                {a.question} {a.answer} ({a.confidence})
              </p>
            ))}
          </Section>
          <Section title="Cost">
            <p>${cost.toFixed(2)}</p>
          </Section>
        </ScrollArea>
      </TabsContent>
      <TabsContent value="log">
        <JobLog job={start.job} log={log} />
      </TabsContent>
    </Tabs>
  );
}

// `events` are the step's own events (not its tool calls). The panel, and its log request, exist only while it is open.
export function StepDetail({ start, events }: { start: RunEvent; events: RunEvent[] }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Details
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-3xl">
        <DialogTitle>{start.step}</DialogTitle>
        <DialogDescription>Prompt, findings, checks and cost of this step, and its CI job log.</DialogDescription>
        <Panel start={start} events={events} />
      </DialogContent>
    </Dialog>
  );
}
