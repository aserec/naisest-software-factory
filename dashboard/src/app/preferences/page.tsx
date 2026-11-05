"use client";

import { useNotifyPref } from "@/components/notifications";
import { field } from "@/components/range-picker";
import { LoadError, PageTitle, SectionHeading, THEMES } from "@/components/shell";
import { Switch } from "@/components/ui/switch";
import { usePreferences } from "@/components/use-preferences";
import { DEFAULT_PREFS, PREFS, type Prefs } from "@/lib/preferences";
import { RANGES } from "@/server/insights"; // types and Intl only, safe in the browser

// One setting: its name and what it does on the left, the control on the right.
function Row({ id, label, hint, children }: { id: string; label: string; hint: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6 py-3">
      <div className="min-w-0">
        <label htmlFor={id} className="font-medium">
          {label}
        </label>
        <p className="mt-0.5 text-sm text-muted-foreground">{hint}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

// Why the notify switch is off or missing in this browser, in words a person can act on.
const NOTIFY_HINT: Record<NotificationPermission | "none", string> = {
  none: "This browser has no notifications.",
  denied: "This browser blocks notifications for the dashboard. Allow them in the browser's site settings, then come back.",
  default: "A browser notification when a work item starts to wait on you. The browser asks once.",
  granted: "A browser notification when a work item starts to wait on you.",
};

export default function PreferencesPage() {
  const { query, me, prefs, save } = usePreferences();
  const notify = useNotifyPref();
  const shown = prefs ?? DEFAULT_PREFS;
  const set = (change: Partial<Prefs>) => save.mutate(change);
  return (
    <main className="max-w-2xl">
      <PageTitle title="Preferences">Saved to your account, so they follow you to any browser.</PageTitle>
      {query.isError && <LoadError what="your preferences" query={query} className="mb-6" />}
      {save.isError && (
        <p role="alert" className="mb-6 text-destructive">
          Could not save the change. {save.error.message}
        </p>
      )}

      <SectionHeading>Appearance</SectionHeading>
      <Row id="theme" label="Theme" hint="System follows your computer's light or dark setting.">
        <select id="theme" className={field} disabled={!prefs} value={shown.theme} onChange={(e) => set({ theme: PREFS.shape.theme.parse(e.target.value) })}>
          {THEMES.map(([t, label]) => (
            <option key={t} value={t}>
              {label}
            </option>
          ))}
        </select>
      </Row>

      <SectionHeading className="mt-8">Notifications</SectionHeading>
      <Row id="notify" label="Browser notifications" hint={NOTIFY_HINT[notify.perm]}>
        <Switch id="notify" checked={notify.on} disabled={!notify.ready || !notify.shown} onCheckedChange={notify.toggle} />
      </Row>

      <SectionHeading className="mt-8">Insights</SectionHeading>
      <Row id="range" label="Default range" hint="The range Insights opens with. A link with its own range still shows that range.">
        <select id="range" className={field} disabled={!prefs} value={shown.insightsRange} onChange={(e) => set({ insightsRange: PREFS.shape.insightsRange.parse(e.target.value) })}>
          {PREFS.shape.insightsRange.options.map((k) => (
            <option key={k} value={k}>
              {RANGES[k]}
            </option>
          ))}
        </select>
      </Row>

      <SectionHeading className="mt-8">Account</SectionHeading>
      <p className="py-3">
        {me ? (
          <>
            Signed in as <span className="font-medium">{me.user.username}</span> with {me.user.signIn}. Sign out from the menu at the top right.
          </>
        ) : (
          <span className="text-muted-foreground">Loading…</span>
        )}
      </p>
    </main>
  );
}
