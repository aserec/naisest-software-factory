import { describe } from "vitest";
import { makeHttpDashboard } from "../adapters/http-dashboard";
import type { RunEvent } from "../seams";
import { dashboardContract } from "./dashboard.contract";

// Manual job only (contract-real in .gitlab-ci.yml): start a dashboard on a temp db by hand and set
// DASHBOARD_CONTRACT_URL and DASHBOARD_CONTRACT_TOKEN (its FACTORY_TOKEN).
const url = process.env.DASHBOARD_CONTRACT_URL;
const token = process.env.DASHBOARD_CONTRACT_TOKEN;
describe.skipIf(!process.env.FACTORY_CONTRACT_REAL || !url || !token)("real dashboard", () => {
  dashboardContract(() => ({
    dashboard: makeHttpDashboard(url!, token!),
    // GET /api/events takes a signed-in person. The read-back works only if the dashboard also takes the factory token.
    read: async (run) => {
      const res = await fetch(`${url}/api/events?run=${encodeURIComponent(run)}&after=0`, { headers: { authorization: `Bearer ${token}` } });
      return res.ok ? ((await res.json()) as { events: RunEvent[] }).events : undefined;
    },
  }));
});
