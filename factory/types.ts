export type Risk = "trivial" | "low" | "medium" | "high";
export interface Answer<T> { value: T; confidence: number }
export interface RouterRow { author: string; effort: "medium" | "high"; reviewer: string; mayAutoMerge: boolean }
export interface Router { low: RouterRow; high: RouterRow; effortBump: number }
export interface Target {
  name: string;
  projectPath: string;
  protectedPaths: string[];
  dependencyFiles: string[];
  maxChangedLines: number;
  defaultApprover: string;
  jobImage: string;
}
export interface FactoryCommands { lint: string; test: string; build: string; smoke?: string }
