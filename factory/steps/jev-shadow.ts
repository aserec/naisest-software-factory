// Jev shadow test, run by a person on their own machine (not in CI):
//   BERGET_API_KEY=... FACTORY_GITLAB_TOKEN=... pnpm tsx factory/steps/jev-shadow.ts <target> <count>
// It reads the newest closed tickets of a target, runs triage on each, and writes run/jev-shadow.csv.
// It only reads from the tracker. It never writes a state, comment or anything else.
import { mkdirSync, writeFileSync } from "node:fs";
import { makeCodeHost, makeTracker } from "../compose";
import { loadTarget } from "../config";
import type { JevClient } from "../jev";
import { makeJevClient } from "../jev";
import type { Ticket } from "../seams";
import { DEFAULT_THRESHOLDS, THRESHOLDS_PATH, readThresholds } from "../thresholds";
import { askTriage, buildTriageState, decideTriage } from "../triage";
import { isMain } from "./context";

export const CSV_HEADER = ["ticket", "title", "injection_p_yes", "type", "type_conf", "risk", "risk_conf", "clarity", "clarity_conf", "effort", "effort_conf", "outcome"];

// A CSV field in quotes when it holds a comma, quote or line break. Quotes are doubled.
// A text starting with = + - or @ gets a ' in front, so a spreadsheet does not read it as a formula.
export const csvField = (v: string | number): string => {
  const t = typeof v === "string" && /^[=+\-@]/.test(v) ? `'${v}` : String(v);
  return /[",\r\n]/.test(t) ? `"${t.replaceAll('"', '""')}"` : t;
};
export const csvLine = (fields: (string | number)[]) => fields.map(csvField).join(",");

export async function shadowRow(jev: JevClient, t: Pick<Ticket, "ref" | "title" | "body" | "tags">, clarityMin = DEFAULT_THRESHOLDS.clarityMin): Promise<string> {
  const a = await askTriage(jev, buildTriageState(t.title, t.body, t.tags));
  const o = decideTriage(a, clarityMin);
  const outcome = o.kind === "blocked" ? `blocked: ${o.reason}` : o.kind === "build" ? `build (${o.risk})` : "needs_info";
  return csvLine([t.ref, t.title, a.injectionYes, a.type.value, a.type.confidence, a.risk.value, a.risk.confidence, a.clarity.value, a.clarity.confidence, a.effort.value, a.effort.confidence, outcome]);
}

export async function main(env = process.env, argv = process.argv.slice(2)) {
  const [targetName, countText] = argv;
  const count = Number(countText);
  if (!targetName || !Number.isInteger(count) || count < 1 || count > 100) throw new Error("Usage: pnpm tsx factory/steps/jev-shadow.ts <target> <count> (count is at most 100)");
  // A shadow test with the mock would tell us nothing, so refuse it.
  if (!env.BERGET_API_KEY) throw new Error("BERGET_API_KEY is not set. The shadow test needs the real Jev, not the mock. Stopping.");
  const token = env.FACTORY_GITHUB_TOKEN || env.FACTORY_GITLAB_TOKEN; // the token of the tracker seams.yml picks
  if (!token) throw new Error("FACTORY_GITLAB_TOKEN (or FACTORY_GITHUB_TOKEN for a github tracker) is not set. It is needed to read closed tickets.");
  const jev = makeJevClient(env);
  const target = loadTarget(targetName);
  const tracker = makeTracker(token, target);
  // The target's clarityMin, as triage would use it. A bad file keeps the default, as in triage.
  const clarityMin = readThresholds(await makeCodeHost(token, target, env).readFile(THRESHOLDS_PATH)).values.clarityMin;
  const lines = [csvLine(CSV_HEADER)];
  for (const t of await tracker.listClosed(count)) lines.push(await shadowRow(jev, t, clarityMin));
  mkdirSync("run", { recursive: true });
  writeFileSync("run/jev-shadow.csv", lines.join("\n") + "\n");
  console.log(`Wrote ${lines.length - 1} rows to run/jev-shadow.csv`);
}
if (isMain(import.meta.url)) await main().catch((e) => { console.error(String(e instanceof Error ? e.message : e)); process.exit(1); });
