import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import { HARNESSES, HARNESS_NAMES } from "./harnesses";
import type { ModelChoice } from "./seams";
import { JEV_HOSTS } from "./jev";
import type { FactoryCommands, RoleChoice, Router, SeamsConfig, Target } from "./types";

// Repo root, found from this file, so tests and CI agree whatever the cwd is.
const root = fileURLToPath(new URL("..", import.meta.url));

const role = z.object({
  harness: z.enum(HARNESS_NAMES),
  provider: z.string().min(1),
  model: z.string().min(1),
  effort: z.enum(["medium", "high"]).optional(),
});
const row = z.object({ author: role, reviewer: role, mayAutoMerge: z.boolean() });
const routerSchema = z.object({ low: row, high: row, writer: role, effortBump: z.number() });

const seamsSchema = z.object({
  tracker: z.string().min(1),
  codeHost: z.string().min(1),
  ci: z.string().min(1),
  judge: z.string().min(1),
  chat: z.string().min(1),
  logSource: z.string().min(1),
  dashboard: z.string().min(1),
  dashboardUrl: z.string().min(1),
  judgeModel: z.object({ provider: z.string().min(1), model: z.string().min(1) }),
  providers: z.record(z.object({
    api: z.enum(["anthropic", "openai"]),
    baseUrl: z.string().url().optional(),
    keyEnv: z.string().min(1),
    onlyHarness: z.enum(HARNESS_NAMES).optional(),
    models: z.record(z.string().min(1)), // model id -> family
    images: z.array(z.string().min(1)).optional(), // model ids that read images
    // USD per million tokens. Pi works out a run's cost from these; without them a custom provider costs $0.
    prices: z.record(z.object({ input: z.number(), output: z.number(), cacheRead: z.number().optional(), cacheWrite: z.number().optional() })).optional(),
  })),
});

// A REPLACE_WITH_ value is a placeholder someone must fill in before go-live. Never run with it.
const real = z.string().min(1).refine((v) => !v.startsWith("REPLACE_WITH_"), { message: "is still a placeholder (REPLACE_WITH_...): set the real value in the target file" });
const targetSchema = z.object({
  name: z.string().min(1),
  projectPath: real,
  baseBranch: z.string().min(1),
  // .factory/** is always protected: a change to a repo's own agent instructions goes to a person.
  protectedPaths: z.array(z.string()).default([]).transform((p) => (p.includes(".factory/**") ? p : [...p, ".factory/**"])),
  dependencyFiles: z.array(z.string()),
  maxChangedLines: z.number().int().positive().optional(), // no key: no line limit
  defaultApprover: real,
  jobImage: z.string().min(1),
  githubRepo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional(),
  githubProject: z.number().int().positive().optional(),
  tracker: z.string().min(1).optional(),
  codeHost: z.string().min(1).optional(),
  sharedAccount: z.boolean().optional(),
  teamsRelay: z.string().min(1).optional(), // the relay bot's tracker username; its comments count only with a person's 👍 (relay.ts)
  stuckMinutes: z.record(z.number().positive()).optional(),
});

const commandsSchema = z.object({
  install: z.string().min(1),
  lint: z.string().min(1),
  test: z.string().min(1),
  build: z.string().min(1),
  smoke: z.string().min(1).optional(),
  preview: z.string().min(1).optional(),
  previewUrl: z.string().url().optional(),
  // Logs a seeded user in for run/shoot.sh: reads $FACTORY_USER and $FACTORY_URL, writes a Playwright storage state to $FACTORY_STORAGE.
  login: z.string().min(1).optional(),
}).refine((c) => !c.preview === !c.previewUrl, { message: "preview and previewUrl go together" })
  .refine((c) => !c.login || c.preview, { message: "login needs preview" });

const readYaml = (path: string) => parse(readFileSync(path, "utf8"));

function validate<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: unknown, file: string): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw new Error(`${file}: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  return r.data;
}

// The key variable of every model provider in seams.yml, then the Jev key. Each name once.
export const providerKeys = (seams: SeamsConfig): string[] => [...new Set([...Object.values(seams.providers).map((p) => p.keyEnv), ...Object.values(JEV_HOSTS).map((h) => h.keyEnv)])];

// The family of a provider's model, or an error naming the field.
function family(seams: SeamsConfig, c: { provider: string; model: string }, field: string): string {
  const p = Object.hasOwn(seams.providers, c.provider) ? seams.providers[c.provider] : undefined;
  if (!p) throw new Error(`${field}: unknown provider ${c.provider}`);
  if (!Object.hasOwn(p.models, c.model)) throw new Error(`${field}: provider ${c.provider} has no model ${c.model}`);
  return p.models[c.model];
}

export function loadSeams(path = `${root}seams.yml`): SeamsConfig {
  const seams = validate(seamsSchema, readYaml(path), "seams.yml");
  for (const [name, p] of Object.entries(seams.providers))
    for (const [field, ids] of [["images", p.images ?? []], ["prices", Object.keys(p.prices ?? {})]] as const)
      for (const id of ids) if (!Object.hasOwn(p.models, id)) throw new Error(`seams.yml providers.${name}.${field}: model ${id} is not in models`);
  family(seams, seams.judgeModel, "seams.yml judgeModel");
  const h = seams.providers[seams.judgeModel.provider].onlyHarness;
  if (h) throw new Error(`seams.yml judgeModel: provider ${seams.judgeModel.provider} works only with harness ${h}`);
  return seams;
}

// Not in seamsSchema: loadSeams runs in many tests, and makeContext is the one place that needs the address.
// FACTORY_DASHBOARD_URL wins only outside GitLab CI (the local scripts): in CI anyone who starts a pipeline
// can set a variable, and the bearer token goes to this address.
export function checkDashboardUrl(seams: SeamsConfig, env: NodeJS.ProcessEnv = {}): string {
  const url = (!env.GITLAB_CI && env.FACTORY_DASHBOARD_URL) || seams.dashboardUrl;
  if (url.startsWith("REPLACE_WITH_")) throw new Error("seams.yml dashboardUrl is still a placeholder (REPLACE_WITH_...): set the dashboard's address");
  // The bearer token goes to this address, so it must be https.
  if (!URL.canParse(url) || new URL(url).protocol !== "https:") throw new Error("seams.yml dashboardUrl must be an https:// address");
  return url;
}

export function loadRouter(path = `${root}router.yml`, seams = loadSeams()): Router {
  const router = validate(routerSchema, readYaml(path), "router.yml");
  const check = (c: RoleChoice, field: string) => {
    const f = family(seams, c, field);
    const p = seams.providers[c.provider];
    if (!HARNESSES[c.harness].apis.includes(p.api)) throw new Error(`${field}: harness ${c.harness} cannot use the ${p.api} api of provider ${c.provider}`);
    if (p.onlyHarness && c.harness !== p.onlyHarness) throw new Error(`${field}: provider ${c.provider} works only with harness ${p.onlyHarness}`);
    return f;
  };
  for (const name of ["low", "high"] as const) {
    const author = check(router[name].author, `router.yml ${name}.author`);
    if (author === check(router[name].reviewer, `router.yml ${name}.reviewer`)) throw new Error(`router.yml ${name}: author and reviewer are both family ${author}`);
  }
  check(router.writer, "router.yml writer");
  return router;
}

// The provider and model a harness gets for one role.
export function modelChoice(c: Pick<RoleChoice, "provider" | "model" | "effort">, seams: SeamsConfig): ModelChoice {
  return { provider: { name: c.provider, ...seams.providers[c.provider] }, model: c.model, effort: c.effort };
}

// override is for tests: targets/react_frontend.yml keeps its placeholder approver until go-live.
export function loadTarget(name: string, override: Partial<Target> = {}): Target {
  return validate(targetSchema, { ...readYaml(`${root}targets/${name}.yml`), ...override }, `targets/${name}.yml`);
}

export function parseFactoryFile(text: string): FactoryCommands {
  return commandsSchema.parse(parse(text));
}
