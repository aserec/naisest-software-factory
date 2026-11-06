import type { HarnessName } from "./harnesses";
import type { Provider } from "./seams";
export type Risk = "trivial" | "low" | "medium" | "high";
export interface Answer<T> { value: T; confidence: number }
export interface RoleChoice { harness: HarnessName; provider: string; model: string; effort?: "medium" | "high" }
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
  maxChangedLines?: number; // undefined: no line limit
  defaultApprover: string;
  jobImage: string;
  githubRepo?: string; // owner/name, for the github and github-project trackers
  githubProject?: number; // the Projects board number, for the github-project tracker
  tracker?: string; // replaces seams.yml tracker for this target
  codeHost?: string; // replaces seams.yml codeHost for this target
  sharedAccount?: boolean; // github trackers: the token's account is also a person's, whose Ready counts
  teamsRelay?: string; // the Teams relay bot's tracker username (relay.ts)
  stuckMinutes?: Record<string, number>; // the dashboard reads it; the factory only accepts it
}
export interface FactoryCommands { install: string; lint: string; test: string; build: string; smoke?: string; preview?: string; previewUrl?: string; login?: string }
