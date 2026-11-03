import picomatch from "picomatch";

// Both GitHub and GitLab read these paths, in this order, and the first that exists wins.
export const CODEOWNERS_PATHS = ["CODEOWNERS", ".gitlab/CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"];

export interface OwnerRule { pattern: string; owners: string[] } // owners without "@", users only

// Comments, blank lines and [Section] headers are skipped. Groups (@org/team) and emails are dropped.
// A rule left with no owners is kept: it still wins over earlier rules, as on the hosts.
export function parseCodeowners(text: string): OwnerRule[] {
  const rules: OwnerRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || /^\^?\[/.test(line)) continue;
    const [pattern, ...who] = line.split(/\s+/);
    rules.push({ pattern, owners: who.filter((o) => /^@[^@/\s]+$/.test(o)).map((o) => o.slice(1)) });
  }
  return rules;
}

const matchers = new Map<string, (path: string) => boolean>();
// gitignore style: a leading or inner slash anchors, a trailing slash means a directory.
// A name with no glob characters also covers everything below it; a glob matches only at its own level.
function matcher(pattern: string) {
  let m = matchers.get(pattern);
  if (!m) {
    const dir = pattern.endsWith("/");
    const p = (dir ? pattern.slice(0, -1) : pattern).replace(/^\//, "");
    const anchored = pattern.startsWith("/") || p.includes("/");
    const base = anchored ? p : `**/${p}`;
    m = picomatch(dir ? [`${base}/**`] : /[*?[]/.test(p) ? [base] : [base, `${base}/**`], { dot: true });
    matchers.set(pattern, m);
  }
  return m;
}

export function ownersOf(rules: OwnerRule[], path: string): string[] {
  for (let i = rules.length - 1; i >= 0; i--) if (matcher(rules[i].pattern)(path)) return rules[i].owners;
  return [];
}

// Owners by how many of the paths they own, most first. Ties go to the owner who comes first in the file.
export function topOwners(rules: OwnerRule[], paths: string[]): string[] {
  const count = new Map<string, number>();
  for (const r of rules) for (const o of r.owners) count.set(o, 0);
  for (const p of paths) for (const o of ownersOf(rules, p)) count.set(o, count.get(o)! + 1);
  return [...count].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([o]) => o);
}
