import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// "250 ms", "45 s", "9 m 5 s", "2 h 20 m". Under a second shows milliseconds, under an hour keeps its seconds.
export function duration(secs: number) {
  if (secs < 1) return `${Math.max(0, Math.round(secs * 1000))} ms`;
  const s = Math.round(secs);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} m${s % 60 ? ` ${s % 60} s` : ""}`;
  const m = Math.round(secs / 60);
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} m` : ""}`;
}

// "just now", "48 m ago", "3 h ago", "2 d ago"; undefined for a date that does not parse.
export function ago(iso: string, now = Date.now()) {
  const m = Math.floor((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(m)) return undefined;
  if (m < 1) return "just now";
  return m < 60 ? `${m} m ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} d ago`;
}

// A factory id as people read it: "code-review" and "code_review" are both "Code review".
// The prepare-patch step and its switch keep their old id in CI and in run records, but people read "Implement".
export const words = (id: string) => (/^prepare[-_]patch$/.test(id) ? "Implement" : id[0].toUpperCase() + id.slice(1).replace(/[-_]/g, " "));

// One work item across targets: "web/12". Board rows, runs and run ends key on it.
export type WorkItemRef = { target: string; ticket: string };
export const workItemKey = (i: WorkItemRef) => `${i.target}/${i.ticket}`;

// "14:05:09", a time of day to the second.
export const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

// "6 Nov 2026, 14:05", a date and time to the minute.
export const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

export const usd = (n: number) => `$${n.toFixed(2)}`;

export const capitalize = (s: string) => s[0].toUpperCase() + s.slice(1);

// The url when it is http(s), else undefined: a url from an event is not trusted as an href (javascript: and the like).
export const httpUrl = (u?: string) => (u && /^https?:\/\//i.test(u) ? u : undefined);
