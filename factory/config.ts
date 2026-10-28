import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import type { FactoryCommands, Router, Target } from "./types";

// Repo root, found from this file, so tests and CI agree whatever the cwd is.
const root = fileURLToPath(new URL("..", import.meta.url));

const row = z.object({
  author: z.string().min(1),
  effort: z.enum(["medium", "high"]),
  reviewer: z.string().min(1),
  mayAutoMerge: z.boolean(),
});
const routerSchema = z.object({ low: row, high: row, effortBump: z.number() });

// A REPLACE_WITH_ value is a placeholder someone must fill in before go-live. Never run with it.
const real = z.string().min(1).refine((v) => !v.startsWith("REPLACE_WITH_"), { message: "is still a placeholder (REPLACE_WITH_...): set the real value in the target file" });
const targetSchema = z.object({
  name: z.string().min(1),
  projectPath: real,
  protectedPaths: z.array(z.string()),
  dependencyFiles: z.array(z.string()),
  maxChangedLines: z.number().int().positive(),
  defaultApprover: real,
  jobImage: z.string().min(1),
});

const commandsSchema = z.object({
  install: z.string().min(1),
  lint: z.string().min(1),
  test: z.string().min(1),
  build: z.string().min(1),
  smoke: z.string().min(1).optional(),
});

const readYaml = (path: string) => parse(readFileSync(path, "utf8"));

export function loadRouter(path = `${root}router.yml`): Router {
  return routerSchema.parse(readYaml(path));
}

// override is for tests: targets/react_frontend.yml keeps its placeholder approver until go-live.
export function loadTarget(name: string, override: Partial<Target> = {}): Target {
  const raw = { ...readYaml(`${root}targets/${name}.yml`), ...override };
  const r = targetSchema.safeParse(raw);
  if (!r.success) throw new Error(`targets/${name}.yml: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  return r.data;
}

export function parseFactoryFile(text: string): FactoryCommands {
  return commandsSchema.parse(parse(text));
}
