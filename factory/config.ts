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

const targetSchema = z.object({
  name: z.string().min(1),
  projectPath: z.string().min(1),
  protectedPaths: z.array(z.string()),
  dependencyFiles: z.array(z.string()),
  maxChangedLines: z.number().int().positive(),
  defaultApprover: z.string().min(1),
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

export function loadTarget(name: string): Target {
  return targetSchema.parse(readYaml(`${root}targets/${name}.yml`));
}

export function parseFactoryFile(text: string): FactoryCommands {
  return commandsSchema.parse(parse(text));
}
