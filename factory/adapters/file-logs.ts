// A LogSource that reads JSON lines from *.log files in a folder. `minutesAgo` keeps the files from going stale.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ErrorGroup, LogSource } from "../seams";

const MINUTE = 60_000;
const HOURS = 24;

// The same error with other ids, numbers or times gets the same fingerprint.
const fingerprint = (logger: string, msg: string) => {
  const text = `${logger} ${msg}`
    .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z?/g, "#")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "#")
    .replace(/\b(?:0x[0-9a-f]+|[0-9a-f]{8,})\b/gi, "#")
    .replace(/\d+/g, "#");
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
};

interface Line { minutesAgo: number; logger?: string; msg: string; component?: string; stack?: string }

export function makeFileLogs(dir: string, now: () => Date = () => new Date()): LogSource {
  return {
    async errors(since) {
      const t0 = now().getTime();
      const groups = new Map<string, ErrorGroup & { first: number; last: number }>();
      for (const file of readdirSync(dir).filter((f) => f.endsWith(".log")).sort()) {
        readFileSync(join(dir, file), "utf8").split("\n").forEach((raw, i) => {
          if (!raw.trim()) return;
          const line = JSON.parse(raw) as Line;
          const hour = Math.floor(line.minutesAgo / 60);
          if (hour >= HOURS) return; // older than 24 hours
          const at = t0 - line.minutesAgo * MINUTE;
          const key = fingerprint(line.logger ?? "", line.msg);
          const g = groups.get(key) ?? { fingerprint: key, message: line.msg, component: line.component, hourly: Array(HOURS).fill(0), firstSeen: "", lastSeen: "", samples: [] as string[], stack: line.stack, link: `${dir.replace(/\/$/, "")}/${file}#L${i + 1}`, first: Infinity, last: -Infinity };
          g.hourly[hour]++;
          g.first = Math.min(g.first, at);
          g.last = Math.max(g.last, at);
          if (g.samples.length < 3) g.samples.push(raw);
          groups.set(key, g);
        });
      }
      return [...groups.values()]
        .filter((g) => g.last >= since.getTime())
        .map(({ first, last, ...g }) => ({ ...g, firstSeen: new Date(first).toISOString(), lastSeen: new Date(last).toISOString() }));
    },
  };
}
