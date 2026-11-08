"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { TargetSettings } from "software-factory/run-events";
import { DEFAULT_THRESHOLDS, THRESHOLD_RULES, TRIAGE_RISKS, type Thresholds } from "software-factory/thresholds";
import { LoadError, PageTitle, SectionHeading } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { ago } from "@/lib/utils";

type Saved = TargetSettings & { user?: string; at?: string };
type NumberKey = Exclude<keyof Thresholds, "autoMergeTriageMax">;

// The number settings in the order the run meets them, with their limits from THRESHOLD_RULES.
const NUMBERS: { key: NumberKey; label: string; help: string; min: number; max: number; step: number }[] = [
  { key: "clarityMin", label: "Lowest clarity to build", help: "Triage asks questions on the work item when its clarity score is below this.", min: 2, max: 10, step: 1 },
  { key: "maxAgentRounds", label: "Most rounds of implement and fix", help: "Code review and the precommit gate each stop and ask a person after this many rounds.", min: 1, max: 10, step: 1 },
  { key: "diffRiskMax", label: "Highest merge risk that merges alone", help: "Jev scores the change's merge risk from 2 to 10. Above this, the change waits for a person.", min: 2, max: 10, step: 1 },
  { key: "autoMergeConfidenceMin", label: "Lowest Jev confidence that merges alone", help: "Jev must be at least this sure of the merge risk and of the scope, from 0.5 to 1.", min: 0.5, max: 1, step: 0.05 },
];

// What the page cannot change: the safety floor every change meets before it may merge alone.
const FIXED = [
  "Every hard rule passes, for example no change to a protected path.",
  "Code review passes and the precommit gate is green.",
  "Medium and high triage risk always wait for a person: the router's high row may not merge alone.",
];

// Only the values that differ from the defaults are saved, so a target with no change follows a new default.
const changed = (t: Thresholds) => Object.fromEntries(Object.entries(t).filter(([k, v]) => DEFAULT_THRESHOLDS[k as keyof Thresholds] !== v));

function TargetForm({ target, saved }: { target: string; saved: Saved }) {
  const client = useQueryClient();
  const [values, setValues] = useState<Thresholds>({ ...DEFAULT_THRESHOLDS, ...(saved.thresholds as Partial<Thresholds>) });
  const [factoryFile, setFactoryFile] = useState(saved.factoryFile ?? "");
  const save = useMutation({
    mutationFn: async () => {
      const r = await api("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ target, thresholds: changed(values), factoryFile }) });
      // 400 and 403 carry the server's sentence: which value is wrong, or which role is missing.
      if (!r.ok) throw new Error(`Could not save the settings for ${target}. ${r.status === 400 || r.status === 403 ? await r.text() : "Try again."}`);
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["settings"] }),
  });
  const id = (k: string) => `${target}-${k}`;
  return (
    <form
      className="flex max-w-2xl flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={id("autoMergeTriageMax")} className="font-medium">
          Highest triage risk that merges alone
        </label>
        <select id={id("autoMergeTriageMax")} value={values.autoMergeTriageMax} onChange={(e) => setValues({ ...values, autoMergeTriageMax: e.target.value as Thresholds["autoMergeTriageMax"] })} className="h-9 w-40 rounded-md border border-input bg-background px-2">
          {TRIAGE_RISKS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <p className="text-muted-foreground">Triage rates each work item trivial, low, medium or high.</p>
      </div>
      {NUMBERS.map((n) => (
        <div key={n.key} className="flex flex-col gap-1">
          <label htmlFor={id(n.key)} className="font-medium">
            {n.label}
          </label>
          <input id={id(n.key)} type="number" required min={n.min} max={n.max} step={n.step} value={values[n.key]} onChange={(e) => setValues({ ...values, [n.key]: e.target.valueAsNumber })} className="h-9 w-40 rounded-md border border-input bg-background px-2 font-mono" />
          <p className="text-muted-foreground">
            {n.help} Default {DEFAULT_THRESHOLDS[n.key]}. It must be {THRESHOLD_RULES[n.key].rule}.
          </p>
        </div>
      ))}
      <div className="flex flex-col gap-1">
        <label htmlFor={id("factoryFile")} className="font-medium">
          .factory.yml commands
        </label>
        <textarea
          id={id("factoryFile")}
          rows={8}
          spellCheck={false}
          value={factoryFile}
          onChange={(e) => setFactoryFile(e.target.value)}
          placeholder={"install: pnpm install --frozen-lockfile\nlint: pnpm lint\ntest: pnpm test\nbuild: pnpm build"}
          className="rounded-md border border-input bg-background p-2 font-mono text-sm"
        />
        <p className="text-muted-foreground">The commands the precommit gate runs in the runner. Leave it empty to use the .factory.yml in the repo.</p>
      </div>
      {save.error && (
        <p role="alert" className="whitespace-pre-line text-destructive">
          {save.error.message}
        </p>
      )}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        {saved.at && (
          <span className="text-muted-foreground" title={new Date(saved.at).toLocaleString()}>
            Saved by {saved.user} {ago(saved.at)}
          </span>
        )}
      </div>
    </form>
  );
}

export default function SettingsPage() {
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const r = await api("/api/settings");
      if (!r.ok) throw new Error(`The settings answered ${r.status}`);
      return (await r.json()) as Record<string, Saved>;
    },
  });
  return (
    <main>
      <PageTitle title="Settings">Each target's limits for merging alone and its .factory.yml commands. The next step of a run uses a saved value.</PageTitle>
      {settings.error && <LoadError what="the settings" query={settings} className="mb-6" />}
      {Object.entries(settings.data ?? {}).map(([target, saved]) => (
        <section key={target} className="mb-10">
          <SectionHeading>
            <span className="font-mono">{target}</span>
          </SectionHeading>
          {/* A new save remounts the form with the saved values. */}
          <TargetForm key={saved.at ?? "none"} target={target} saved={saved} />
        </section>
      ))}
      <section className="max-w-2xl">
        <SectionHeading>Always required to merge alone</SectionHeading>
        <ul className="list-disc pl-5 text-muted-foreground">
          {FIXED.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}
