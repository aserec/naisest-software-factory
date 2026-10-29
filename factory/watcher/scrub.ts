import type { ErrorGroup } from "../seams";
import { findSecrets, HELD_SECRET } from "../rules";

const GONE = "[removed]";
const MAX = 20_000; // the longest text we keep, so one huge log line cannot fill a ticket
// The key rules test the key in a callback and start only at the start of a run, so they stay linear.
const SECRET_KEY = /name|email|user|customer|phone|token|password|secret|address|ip/i;
// Order matters: long tokens go first so the phone rule does not cut their digits.
const RULES: [RegExp, string | ((m: string, k: string, sep: string) => string)][] = [
  [/Bearer\s+[\w.~+/=-]+/gi, GONE],
  [/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, GONE],
  // Hex and base64 runs. A run with no digit is a word or a path, so it stays.
  [/[A-Za-z0-9+/_-]{20,}={0,2}/g, (m: string) => (/\d/.test(m) ? GONE : m)],
  [/"([\w.-]*)"(\s*:\s*)"[^"]*"/g, (m, k, sep) => (SECRET_KEY.test(k) ? `"${k}"${sep}"${GONE}"` : m)], // JSON
  [/(?<![\w.-])([\w.-]+)(\s*=\s*)[^\s&,;"')]+/g, (m, k, sep) => (SECRET_KEY.test(k) ? `${k}${sep}${GONE}` : m)], // key=value, URL query
  [/(?<![\w.-])([\w.-]+)(:\s+)[^\n,;"')]+/g, (m, k, sep) => (SECRET_KEY.test(k) ? `${k}${sep}${GONE}` : m)], // key: value
  [/(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+(?:\s*\([^)]{0,200}\))?/g, GONE], // email, and "(name, phone)" right after it
  [/\+?\d(?:[ -]?\d){6,}/g, GONE], // phone
];

/** Replaces customer data and secrets with "[removed]". Over-removing is fine; leaking is not. */
export function scrub(text: string): string {
  const hits = findSecrets(text);
  // A secret this process holds shows as a placeholder, so we cannot find it: drop the whole text.
  if (hits.includes(HELD_SECRET)) return GONE;
  let out = hits.reduce((t, h) => t.split(h).join(GONE), text);
  for (const [re, to] of RULES) out = out.replace(re, to as string);
  // Cut after scrubbing, so a cut never leaves half of a value the rules need whole.
  return out.length <= MAX ? out : out.slice(0, MAX) + "[truncated]";
}

export const scrubGroup = (g: ErrorGroup): ErrorGroup => ({
  ...g,
  message: scrub(g.message),
  samples: g.samples.map(scrub),
  ...(g.stack === undefined ? {} : { stack: scrub(g.stack) }),
});
