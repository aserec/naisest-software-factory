const SECRET_PATTERNS = [/glpat-[A-Za-z0-9_-]{20,}/g, /-----BEGIN [A-Z ]*PRIVATE KEY-----/g];

/** Returns the secret-looking strings found in the text. */
export function findSecrets(text: string): string[] {
  return SECRET_PATTERNS.flatMap((re) => text.match(re) ?? []);
}
