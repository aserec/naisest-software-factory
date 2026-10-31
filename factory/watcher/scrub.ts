import type { ErrorGroup } from "../seams";
import { findSecrets, HELD_SECRET } from "../rules";

const GONE = "[removed]";
const MAX = 20_000; // the longest text we keep, so one huge log line cannot fill a ticket
const SECRET_KEY = /name|email|user|customer|phone|token|password|secret|address|ip/i;

// Removes the value after every private-looking key. A key that is not private is skipped
// but its value is still scanned, so "next=/cb?token=abc" is caught. Each key regex starts only at
// the start of a run, so the scan stays linear on long input.
const keyed = (key: RegExp, value: RegExp, to: string) => (text: string) => {
  let out = "";
  let from = 0;
  for (const m of text.matchAll(key)) {
    const end = m.index + m[0].length;
    if (m.index < from || !SECRET_KEY.test(m[1])) continue;
    value.lastIndex = end;
    const v = value.exec(text);
    if (!v) continue;
    out += text.slice(from, end) + to;
    from = end + v[0].length;
  }
  return out + text.slice(from);
};
const replace = (re: RegExp, to: string | ((m: string) => string)) => (text: string) => text.replace(re, to as string);

// Order matters: long tokens go first so the phone rule does not cut their digits.
const RULES = [
  replace(/Bearer\s+[\w.~+/=-]+/gi, GONE),
  replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, GONE),
  // Hex and base64 runs. A run with no digit is a word or a path, so it stays.
  replace(/[A-Za-z0-9+/_-]{20,}={0,2}/g, (m) => (/\d/.test(m) ? GONE : m)),
  keyed(/"([\w.-]*)"\s*:\s*/g, /"[^"]*"/y, `"${GONE}"`), // JSON
  keyed(/(?<![\w.-])([\w.-]+)\s*=\s*/g, /[^\s&,;"')]+/y, GONE), // key=value, URL query
  keyed(/(?<![\w.-])([\w.-]+):\s+/g, /[^\n,;"')]+/y, GONE), // key: value
  replace(/(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+(?:\s*\([^)]{0,200}\))?/g, GONE), // email, and "(name, phone)" right after it
  replace(/\+?\d(?:[ -]?\d){6,}/g, GONE), // phone
];

/** Replaces customer data and secrets with "[removed]". Over-removing is fine; leaking is not. */
// ponytail: only keyed values, emails, phones and tokens are caught. A name with no key ("Jane Doe <j@x.com>"
// keeps "Jane Doe", and a free-standing name stays whole). Fine for the files log source, whose errors are fake.
// Before a real log source adapter, solve it: keep only allowlisted fields, or scrub with a model.
export function scrub(text: string): string {
  const hits = findSecrets(text);
  // A secret this process holds shows as a placeholder, so we cannot find it: drop the whole text.
  if (hits.includes(HELD_SECRET)) return GONE;
  let out = hits.reduce((t, h) => t.split(h).join(GONE), text);
  for (const rule of RULES) out = rule(out);
  // Cut after scrubbing, so a cut never leaves half of a value the rules need whole.
  return out.length <= MAX ? out : out.slice(0, MAX) + "[truncated]";
}

export const scrubGroup = (g: ErrorGroup): ErrorGroup => ({
  ...g,
  message: scrub(g.message),
  samples: g.samples.map(scrub),
  link: scrub(g.link), // the writer and the ticket both see it
  ...(g.stack === undefined ? {} : { stack: scrub(g.stack) }),
});
