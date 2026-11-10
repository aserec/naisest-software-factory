import { parse } from "yaml";
import { z } from "zod";

// {port} in any command or previewUrl is the run's own free port (FACTORY_PORT, else DEFAULT_PORT): parallel local runs
// each start their dev server on another port. The record keeps {port}, so a run resumed in another slot gets that slot's port.
export const DEFAULT_PORT = "3910";
// The .factory.yml commands. It imports only yaml and zod, so the dashboard checks the Settings page's text with the same schema.
const commandsSchema = z.object({
  install: z.string().min(1),
  lint: z.string().min(1),
  test: z.string().min(1),
  build: z.string().min(1),
  smoke: z.string().min(1).optional(),
  preview: z.string().min(1).optional(),
  previewUrl: z.string().refine((u) => URL.canParse(u.replaceAll("{port}", DEFAULT_PORT)), { message: "Invalid url" }).optional(),
  // Logs a seeded user in for run/shoot.sh: reads $FACTORY_USER and $FACTORY_URL, writes a Playwright storage state to $FACTORY_STORAGE.
  login: z.string().min(1).optional(),
  // More commands the author may run, such as a script that writes a generated file the ticket asks to commit.
  author: z.array(z.string().min(1)).optional(),
}).refine((c) => !c.preview === !c.previewUrl, { message: "preview and previewUrl go together" })
  .refine((c) => !c.login || c.preview, { message: "login needs preview" });

// The same shape as FactoryCommands in types.ts, which this file does not import.
export function parseFactoryFile(text: string): z.infer<typeof commandsSchema> {
  return commandsSchema.parse(parse(text));
}

// The commands with {port} replaced by port.
export function withPort<T extends object>(c: T, port: string): T {
  const fill = (v: unknown): unknown => (typeof v === "string" ? v.replaceAll("{port}", port) : Array.isArray(v) ? v.map(fill) : v);
  return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, fill(v)])) as T;
}
