import { LANGUAGES, type Language } from "software-factory/run-events";
import { z } from "zod";
import { DEFAULT_RANGE, type RangeKey } from "@/server/insights"; // types and Intl only, safe in the browser

// What a person can set for themselves. Saved per user in the database, so it follows them to any browser.
const RANGE_KEYS = ["today", "yesterday", "24h", "7d", "30d", "year"] as const satisfies readonly RangeKey[];

export const PREFS = z
  .object({
    theme: z.enum(["system", "light", "dark"]),
    // Browser notifications when a work item starts to wait on you. The browser's own permission is still needed.
    notify: z.boolean(),
    // The range Insights opens with when the URL names none.
    insightsRange: z.enum(RANGE_KEYS),
    // The language of the dashboard's own text. What the agents write follows each target's language on the Settings page.
    language: z.enum(Object.keys(LANGUAGES) as [Language, ...Language[]]),
  })
  .strict();

export type Prefs = z.infer<typeof PREFS>;
export type Theme = Prefs["theme"];
export const DEFAULT_PREFS: Prefs = { theme: "system", notify: false, insightsRange: DEFAULT_RANGE as Prefs["insightsRange"], language: "en" };

/** What GET /api/preferences answers. */
export interface Me { user: { username: string; signIn: string }; prefs: Prefs }
