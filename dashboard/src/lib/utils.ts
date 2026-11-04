import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// "45 s", "9 m", "2 h 20 m". Durations under a minute keep their seconds.
export function duration(secs: number) {
  if (secs < 60) return `${Math.max(0, Math.round(secs))} s`;
  const m = Math.round(secs / 60);
  return m < 60 ? `${m} m` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} m` : ""}`;
}

// "just now", "48 m ago", "3 h ago", "2 d ago"; undefined for a date that does not parse.
export function ago(iso: string, now = Date.now()) {
  const m = Math.floor((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(m)) return undefined;
  if (m < 1) return "just now";
  return m < 60 ? `${m} m ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} d ago`;
}

// A factory id as people read it: "prepare-patch" and "prepare_patch" are both "Prepare patch".
export const words = (id: string) => id[0].toUpperCase() + id.slice(1).replace(/[-_]/g, " ");

export const usd = (n: number) => `$${n.toFixed(2)}`;
