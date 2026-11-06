import type { EventData } from "software-factory/run-events";
import { usd } from "@/lib/utils";

export const count = (n: number) => n.toLocaleString("en");

const TOKENS = ["input", "output", "cacheRead", "cacheWrite"] as const;
type Usage = Record<(typeof TOKENS)[number] | "costUsd", number>;

// Usage events summed per role and model, and in all. unpriced: the models with no price in seams.yml; they report tokens and $0.
export function usageByModel(usage: EventData<"usage">[]) {
  const rows = new Map<string, Usage & { role: string; model: string }>();
  const total: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
  for (const u of usage) {
    const key = `${u.role} · ${u.model}`;
    const row = rows.get(key) ?? rows.set(key, { role: u.role, model: u.model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }).get(key)!;
    for (const k of [...TOKENS, "costUsd"] as const) {
      row[k] += u[k];
      total[k] += u[k];
    }
  }
  const unpriced = [...new Set(usage.filter((u) => !u.costUsd && (u.input || u.output)).map((u) => u.model))];
  return { rows: [...rows.values()], total, unpriced };
}

export const Unpriced = ({ models }: { models: string[] }) => models.length > 0 && <div className="text-muted-foreground">Without {models.join(" and ")}: seams.yml sets no price for it</div>;

// The whole run's tokens and cost per role and model, for the run page.
export function CostByModel({ usage }: { usage: EventData<"usage">[] }) {
  const { rows, total, unpriced } = usageByModel(usage);
  const num = "py-2 pl-4 text-right whitespace-nowrap";
  const cells = (u: Usage) => (
    <>
      {TOKENS.map((k) => (
        <td key={k} className={num}>
          {count(u[k])}
        </td>
      ))}
      <td className={num}>{usd(u.costUsd)}</td>
    </>
  );
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[36rem]">
          <thead className="text-muted-foreground">
            <tr className="border-b">
              {["Role and model", "Input", "Output", "Cache read", "Cache write", "Cost"].map((h, i) => (
                <th key={h} scope="col" className={i ? `${num} font-normal` : "py-2 text-left font-normal"}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.role} ${r.model}`} className="border-b border-rule">
                <th scope="row" className="py-2 text-left font-normal">
                  {r.role} · <span className="font-mono text-xs">{r.model}</span>
                </th>
                {cells(r)}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-medium">
              <th scope="row" className="py-2 text-left font-medium">
                Total
              </th>
              {cells(total)}
            </tr>
          </tfoot>
        </table>
      </div>
      <Unpriced models={unpriced} />
    </>
  );
}
