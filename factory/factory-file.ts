import { parse } from "yaml";
import { z } from "zod";

// The .factory.yml commands. It imports only yaml and zod, so the dashboard checks the Settings page's text with the same schema.
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
  // More commands the author may run, such as a script that writes a generated file the ticket asks to commit.
  author: z.array(z.string().min(1)).optional(),
}).refine((c) => !c.preview === !c.previewUrl, { message: "preview and previewUrl go together" })
  .refine((c) => !c.login || c.preview, { message: "login needs preview" });

// The same shape as FactoryCommands in types.ts, which this file does not import.
export function parseFactoryFile(text: string): z.infer<typeof commandsSchema> {
  return commandsSchema.parse(parse(text));
}
