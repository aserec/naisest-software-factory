import { DEFAULT_PREFS, PREFS, type Prefs } from "@/lib/preferences";
import { getDb } from "./db-instance";
import type { SessionUser } from "./seams";

// The same username can exist on GitHub and on GitLab, so the key names the sign-in too.
export const prefsKey = (u: SessionUser) => `${u.signIn}:${u.userId}`;

// Saved values over the defaults. A saved value that no longer passes the schema falls back to its default.
export function readPrefs(u: SessionUser): Prefs {
  const saved = getDb().preferences(prefsKey(u));
  const out = { ...DEFAULT_PREFS };
  for (const k of Object.keys(DEFAULT_PREFS) as (keyof Prefs)[]) {
    const r = PREFS.shape[k].safeParse(saved[k]);
    if (r.success) Object.assign(out, { [k]: r.data });
  }
  return out;
}

export function savePrefs(u: SessionUser, change: Partial<Prefs>): Prefs {
  const prefs = { ...readPrefs(u), ...change };
  getDb().setPreferences(prefsKey(u), prefs);
  return prefs;
}
