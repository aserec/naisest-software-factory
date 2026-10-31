import { fakeDashboard } from "../fakes";
import { dashboardContract } from "./dashboard.contract";

dashboardContract(() => {
  const dashboard = fakeDashboard();
  return { dashboard, read: async (run) => dashboard.events.filter((e) => e.run === run) };
});
