import type { Provider } from "./seams";
export type Risk = "trivial" | "low" | "medium" | "high";
export interface Answer<T> { value: T; confidence: number }
export interface RoleChoice { harness: "claude-code" | "pi"; provider: string; model: string; effort?: "medium" | "high" }
export interface RouterRow { author: RoleChoice; reviewer: RoleChoice; mayAutoMerge: boolean }
export interface Router { low: RouterRow; high: RouterRow; writer: RoleChoice; effortBump: number }
// seams.yml: the adapter per seam and the providers. Names are checked against the adapter map in makeContext.
export interface SeamsConfig {
  tracker: string; codeHost: string; ci: string; judge: string; chat: string; logSource: string;
  dashboard: string; dashboardUrl: string;
  judgeModel: { provider: string; model: string };
  providers: Record<string, Omit<Provider, "name">>;
}
export interface Target {
  name: string;
  projectPath: string;
  baseBranch: string;
  protectedPaths: string[];
  dependencyFiles: string[];
  maxChangedLines: number;
  defaultApprover: string;
  jobImage: string;
  stuckMinutes?: Record<string, number>; // the dashboard reads it; the factory only accepts it
}
export interface FactoryCommands { install: string; lint: string; test: string; build: string; smoke?: string; preview?: string; previewUrl?: string }
