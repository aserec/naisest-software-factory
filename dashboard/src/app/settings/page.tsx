"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type Language, type SwitchName, type TargetSettings } from "software-factory/run-events";
import { DEFAULT_THRESHOLDS, THRESHOLD_RULES, TRIAGE_RISKS, type Thresholds } from "software-factory/thresholds";
import { LoadError, PageTitle, SectionHeading } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useT } from "@/components/use-preferences";
import { api } from "@/lib/api";
import { LANGUAGE_NAMES } from "@/lib/i18n";
import { PREFS } from "@/lib/preferences";
import { ago } from "@/lib/utils";

type Saved = TargetSettings & { user?: string; at?: string; fileLanguage?: string };
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
  const [language, setLanguage] = useState<Language | "">(saved.language ?? "");
  const t = useT();
  // Auto-merge is the target's auto_merge switch, the same value as its cell on the Switches page.
  const switches = useQuery({
    queryKey: ["switches"],
    queryFn: async () => {
      const r = await api("/api/switches");
      if (!r.ok) throw new Error(`The switches answered ${r.status}`);
      return (await r.json()) as Record<string, Record<SwitchName, boolean>>;
    },
  });
  const allOff = switches.data?.["*"]?.auto_merge === false;
  const savedAutoMerge = switches.data?.[target]?.auto_merge;
  const [autoMergeEdit, setAutoMerge] = useState<boolean>();
  const autoMerge = autoMergeEdit ?? savedAutoMerge;
  const save = useMutation({
    mutationFn: async () => {
      const autoMergeChange = autoMerge === undefined || autoMerge === savedAutoMerge ? {} : { autoMerge };
      const r = await api("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ target, thresholds: changed(values), factoryFile, language, ...autoMergeChange }) });
      // 400 and 403 carry the server's sentence: which value is wrong, or which role is missing.
      if (!r.ok) throw new Error(`Could not save the settings for ${target}. ${r.status === 400 || r.status === 403 ? await r.text() : "Try again."}`);
    },
    onSettled: async () => {
      await client.invalidateQueries({ queryKey: ["switches"] });
      setAutoMerge(undefined);
      await client.invalidateQueries({ queryKey: ["settings"] });
    },
  });
  const id = (k: string) => `${target}-${k}`;
  return (
    <form
      className="flex max-w-2xl flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={id("language")} className="font-medium">
          {t("Agents' language")}
        </label>
        <select id={id("language")} value={language} onChange={(e) => setLanguage(e.target.value as Language | "")} className="h-9 w-56 rounded-md border border-input bg-background px-2">
          <option value="">{t("From the target file ({name})", { name: saved.fileLanguage ?? "English" })}</option>
          {PREFS.shape.language.options.map((l) => (
            <option key={l} value={l}>
              {LANGUAGE_NAMES[l]}
            </option>
          ))}
        </select>
        <p className="text-muted-foreground">{t("The language the agents write ticket comments, questions, dashboard notes, commit messages and pull requests in.")}</p>
      </div>
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <label htmlFor={id("auto_merge")} className="font-medium">
            {t("Auto-merge")}
          </label>
          <Switch id={id("auto_merge")} checked={!!autoMerge} disabled={autoMerge === undefined || allOff} onCheckedChange={setAutoMerge} />
        </div>
        <p className="text-muted-foreground">{t(allOff ? "Off for all targets on the Switches page." : autoMerge === false ? "Every change waits for a person to approve it." : "Low-risk changes whose checks pass merge without a person, within the limits below.")}</p>
        {switches.error && <LoadError what="the auto-merge switch" query={switches} />}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={id("autoMergeTriageMax")} className="font-medium">
          {t("Highest triage risk that merges alone")}
        </label>
        <select id={id("autoMergeTriageMax")} value={values.autoMergeTriageMax} onChange={(e) => setValues({ ...values, autoMergeTriageMax: e.target.value as Thresholds["autoMergeTriageMax"] })} className="h-9 w-40 rounded-md border border-input bg-background px-2">
          {TRIAGE_RISKS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <p className="text-muted-foreground">{t("Triage rates each work item trivial, low, medium or high.")}</p>
      </div>
      {NUMBERS.map((n) => (
        <div key={n.key} className="flex flex-col gap-1">
          <label htmlFor={id(n.key)} className="font-medium">
            {t(n.label)}
          </label>
          <input id={id(n.key)} type="number" required min={n.min} max={n.max} step={n.step} value={values[n.key]} onChange={(e) => setValues({ ...values, [n.key]: e.target.valueAsNumber })} className="h-9 w-40 rounded-md border border-input bg-background px-2 font-mono" />
          <p className="text-muted-foreground">
            {t(n.help)} {t("Default {value}. It must be {rule}.", { value: DEFAULT_THRESHOLDS[n.key], rule: THRESHOLD_RULES[n.key].rule })}
          </p>
        </div>
      ))}
      <div className="flex flex-col gap-1">
        <label htmlFor={id("factoryFile")} className="font-medium">
          {t(".factory.yml commands")}
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
        <p className="text-muted-foreground">{t("The commands the precommit gate runs in the runner. Leave it empty to use the .factory.yml in the repo.")}</p>
      </div>
      {save.error && (
        <p role="alert" className="whitespace-pre-line text-destructive">
          {save.error.message}
        </p>
      )}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? t("Saving…") : t("Save")}
        </Button>
        {saved.at && (
          <span className="text-muted-foreground" title={new Date(saved.at).toLocaleString()}>
            {t("Saved by {user} {when}", { user: saved.user ?? "", when: ago(saved.at) ?? "" })}
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
  const targets = Object.entries(settings.data ?? {});
  const [tab, setTab] = useState<string>();
  const t = useT();
  return (
    <main data-fill>
      <PageTitle title={t("Settings")}>{t("Each target's limits for merging alone and its .factory.yml commands. The next step of a run uses a saved value.")}</PageTitle>
      {settings.error && <LoadError what="the settings" query={settings} className="mb-6" />}
      <Tabs value={tab ?? targets[0]?.[0] ?? "factory"} onValueChange={setTab} data-fill>
        <TabsList>
          {targets.map(([target]) => (
            <TabsTrigger key={target} value={target} className="font-mono">
              {target}
            </TabsTrigger>
          ))}
          <TabsTrigger value="factory">{t("Factory")}</TabsTrigger>
        </TabsList>
        {/* forceMount keeps unsaved edits in a hidden tab. */}
        {targets.map(([target, saved]) => (
          <TabsContent key={target} value={target} forceMount data-scroll className="data-[state=inactive]:hidden">
            {/* A new save remounts the form with the saved values. */}
            <TargetForm key={saved.at ?? "none"} target={target} saved={saved} />
          </TabsContent>
        ))}
        <TabsContent value="factory" data-scroll>
          <div className="max-w-2xl">
          <SectionHeading>{t("Always required to merge alone")}</SectionHeading>
          <ul className="list-disc pl-5 text-muted-foreground">
            {FIXED.map((f) => (
              <li key={f}>{t(f)}</li>
            ))}
          </ul>
          </div>
        </TabsContent>
      </Tabs>
    </main>
  );
}
