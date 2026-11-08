import { describe, expect, it, vi } from "vitest";
import { fakeDashboard } from "./fakes";
import { fixTick } from "./fixer";
import type { AgentPlan } from "./seams";

const plan = (id: string, state: AgentPlan["state"] = "approved"): AgentPlan => ({ id, path: "/runs/1", repo: "factory", summary: "s", steps: ["a"], state, user: "u", at: "2026-01-01T00:00:00Z" });

describe("fixTick", () => {
  it("claims an approved plan and runs it once", async () => {
    const d = fakeDashboard();
    d.agentPlans.push(plan("a"));
    const states: string[] = [];
    const run = vi.fn(async () => { states.push(d.agentPlans[0].state); return 0; });
    await fixTick(d, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(states).toEqual(["running"]); // the claim came first
  });

  it("does not run a plan whose claim is refused", async () => {
    const d = fakeDashboard();
    d.agentPlans.push(plan("a"));
    d.planUpdate = async () => false;
    const run = vi.fn(async () => 0);
    await fixTick(d, run);
    expect(run).not.toHaveBeenCalled();
  });

  it("marks the plan failed when the step exits non-zero", async () => {
    const d = fakeDashboard();
    d.agentPlans.push(plan("a"));
    await fixTick(d, async () => 1);
    expect(d.agentPlans[0]).toMatchObject({ state: "failed", result: "The fix step ended with code 1" });
  });

  it("marks the plan failed when running it throws, and goes on to the next plan", async () => {
    const d = fakeDashboard();
    d.agentPlans.push(plan("a"), plan("b"));
    const run = vi.fn(async (p: AgentPlan) => { if (p.id === "a") throw new Error("boom"); return 0; });
    await fixTick(d, run);
    expect(d.agentPlans[0]).toMatchObject({ state: "failed" });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("ends the tick without throwing when the dashboard cannot be reached", async () => {
    const d = fakeDashboard();
    d.plans = async () => { throw new Error("down"); };
    await expect(fixTick(d, async () => 0)).resolves.toBeUndefined();
  });
});
