// Reads the inbox file for the agent side (the Claude hook and the Pi extension). Node modules only, so both can load it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// The inbox file has one JSON line per poll with news. `<file>.read` holds how many lines were read.
export function readNew(file: string): { comments: string[]; stop: boolean } {
  const out = { comments: [] as string[], stop: false };
  if (!existsSync(file)) return out;
  const lines = readFileSync(file, "utf8").split("\n").slice(0, -1); // a last line without its newline is still being written
  const read = existsSync(`${file}.read`) ? Number(readFileSync(`${file}.read`, "utf8")) || 0 : 0;
  writeFileSync(`${file}.read`, String(lines.length));
  for (const line of lines.slice(read)) {
    try {
      const r = JSON.parse(line);
      out.comments.push(...r.comments);
      out.stop ||= r.stop === true;
    } catch { /* skip a broken line */ }
  }
  return out;
}
