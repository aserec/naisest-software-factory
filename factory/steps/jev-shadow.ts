// Jev shadow test, run by a person on their own machine (not in CI):
//   BERGET_API_KEY=... FACTORY_GITLAB_TOKEN=... pnpm tsx factory/steps/jev-shadow.ts <target> <count>
// It reads the newest closed work items of a target, runs triage on each, and writes run/jev-shadow.csv.
// It only reads from GitLab. It never writes a label, comment or anything else.
import { mkdirSync, writeFileSync } from "node:fs";
import { loadTarget } from "../config";
import { GitLab } from "../gitlab";
import type { JevClient } from "../jev";
import { makeJevClient } from "../jev";
import { askTriage, buildTriageState, decideTriage } from "../triage";
import { GITLAB_URL, isMain } from "./context";

export const CSV_HEADER = ["iid", "title", "injection_p_yes", "type", "type_conf", "risk", "risk_conf", "clarity", "clarity_conf", "effort", "effort_conf", "outcome"];

// A CSV field in quotes when it holds a comma, quote or line break. Quotes are doubled.
export const csvField = (v: string | number): string => (/[",\r\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v));
export const csvLine = (fields: (string | number)[]) => fields.map(csvField).join(",");

export async function shadowRow(jev: JevClient, item: { iid: number; title: string; description: string; labels: string[] }): Promise<string> {
  const a = await askTriage(jev, buildTriageState(item.title, item.description, item.labels));
  const o = decideTriage(a);
  const outcome = o.kind === "blocked" ? `blocked: ${o.reason}` : o.kind === "build" ? `build (${o.risk})` : "needs_info";
  return csvLine([item.iid, item.title, a.injectionYes, a.type.value, a.type.confidence, a.risk.value, a.risk.confidence, a.clarity.value, a.clarity.confidence, a.effort.value, a.effort.confidence, outcome]);
}

export async function main(env = process.env, argv = process.argv.slice(2)) {
  const [targetName, countText] = argv;
  const count = Number(countText);
  if (!targetName || !Number.isInteger(count) || count < 1) throw new Error("Usage: pnpm tsx factory/steps/jev-shadow.ts <target> <count>");
  // A shadow test with the mock would tell us nothing, so refuse it.
  if (!env.BERGET_API_KEY) throw new Error("BERGET_API_KEY is not set. The shadow test needs the real Jev, not the mock. Stopping.");
  if (!env.FACTORY_GITLAB_TOKEN) throw new Error("FACTORY_GITLAB_TOKEN is not set. It is needed to read closed work items.");
  const jev = makeJevClient(env);
  const gitlab = new GitLab(GITLAB_URL, env.FACTORY_GITLAB_TOKEN);
  const { id } = await gitlab.getProject(loadTarget(targetName).projectPath);
  const lines = [csvLine(CSV_HEADER)];
  for (const item of await gitlab.listClosed(id, count)) lines.push(await shadowRow(jev, item));
  mkdirSync("run", { recursive: true });
  writeFileSync("run/jev-shadow.csv", lines.join("\n") + "\n");
  console.log(`Wrote ${lines.length - 1} rows to run/jev-shadow.csv`);
}
if (isMain(import.meta.url)) await main().catch((e) => { console.error(String(e instanceof Error ? e.message : e)); process.exit(1); });
