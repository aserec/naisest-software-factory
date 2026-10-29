import type { ErrorGroup } from "../seams";
import { findSecrets, HELD_SECRET } from "../rules";

const GONE = "[removed]";
const MAX = 20_000; // log text is attacker-influenced and some rules are slow on very long runs
const KEY = "[\\w.-]*(?:name|email|user|customer|phone|token|password|secret|address|ip)[\\w.-]*";

// Order matters: long tokens go first so the phone rule does not cut their digits.
const RULES: [RegExp, string | ((m: string) => string)][] = [
  [/Bearer\s+[\w.~+/=-]+/gi, GONE],
  [/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, GONE],
  // Hex and base64 runs. A run with no digit is a word or a path, so it stays.
  [/[A-Za-z0-9+/_-]{20,}={0,2}/g, (m: string) => (/\d/.test(m) ? GONE : m)],
  [new RegExp(`("${KEY}"\\s*:\\s*)"[^"]*"`, "gi"), `$1"${GONE}"`], // JSON
  [new RegExp(`\\b(${KEY}\\s*=\\s*)[^\\s&,;"')]+`, "gi"), `$1${GONE}`], // key=value, URL query
  [new RegExp(`\\b(${KEY}:\\s+)[^\\n,;"')]+`, "gi"), `$1${GONE}`], // key: value
  [/(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+(?:\s*\([^)]*\))?/g, GONE], // email, and "(name, phone)" right after it
  [/\+?\d(?:[ -]?\d){6,}/g, GONE], // phone
];

/** Replaces customer data and secrets with "[removed]". Over-removing is fine; leaking is not. */
export function scrub(input: string): string {
  // Cut at a space so no half token is left at the end.
  const cut = input.slice(0, MAX);
  const text = input.length <= MAX ? input : cut.slice(0, Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n")) + 1) + "[truncated]";
  const hits = findSecrets(text);
  // A secret this process holds shows as a placeholder, so we cannot find it: drop the whole text.
  if (hits.includes(HELD_SECRET)) return GONE;
  let out = hits.reduce((t, h) => t.split(h).join(GONE), text);
  for (const [re, to] of RULES) out = out.replace(re, to as string);
  return out;
}

export const scrubGroup = (g: ErrorGroup): ErrorGroup => ({
  ...g,
  message: scrub(g.message),
  samples: g.samples.map(scrub),
  ...(g.stack === undefined ? {} : { stack: scrub(g.stack) }),
});
