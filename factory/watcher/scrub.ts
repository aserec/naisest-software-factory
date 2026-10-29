import type { ErrorGroup } from "../seams";
import { findSecrets } from "../rules";

const GONE = "[removed]";
const KEY = "[\\w.-]*(?:name|email|user|customer|phone|token|password|secret|address|ip)[\\w.-]*";

// Order matters: long tokens go first so the phone rule does not cut their digits.
const RULES: [RegExp, string][] = [
  [/Bearer\s+[\w.~+/=-]+/gi, GONE],
  [/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, GONE],
  [/(?=[A-Za-z0-9+/]*\d)[A-Za-z0-9+/]{20,}={0,2}/g, GONE], // hex and base64 runs
  [new RegExp(`("${KEY}"\\s*:\\s*)"[^"]*"`, "gi"), `$1"${GONE}"`], // JSON
  [new RegExp(`\\b(${KEY}\\s*=\\s*)[^\\s&,;"')]+`, "gi"), `$1${GONE}`], // key=value, URL query
  [new RegExp(`\\b(${KEY}:\\s+)[^\\n,;"')]+`, "gi"), `$1${GONE}`], // key: value
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+(?:\s*\([^)]*\))?/g, GONE], // email, and "(name, phone)" right after it
  [/\+?\d(?:[ -]?\d){6,}/g, GONE], // phone
];

/** Replaces customer data and secrets with "[removed]". Over-removing is fine; leaking is not. */
export function scrub(text: string): string {
  const hits = findSecrets(text);
  // A secret this process holds shows as a placeholder, so we cannot find it: drop the whole text.
  if (hits.some((h) => !text.includes(h))) return GONE;
  let out = hits.reduce((t, h) => t.split(h).join(GONE), text);
  for (const [re, to] of RULES) out = out.replace(re, to);
  return out;
}

export const scrubGroup = (g: ErrorGroup): ErrorGroup => ({
  ...g,
  message: scrub(g.message),
  samples: g.samples.map(scrub),
  ...(g.stack === undefined ? {} : { stack: scrub(g.stack) }),
});
