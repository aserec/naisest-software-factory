import { parseFactoryFile } from "software-factory/factory-file";
import { isLanguage } from "software-factory/run-events";
import { checkThresholds } from "software-factory/thresholds";
import { auth } from "@/server/auth";
import { controlUser } from "@/server/control-user";
import { getDb } from "@/server/db-instance";
import { readTargets } from "@/server/targets";

// Every target's settings as stored, with who saved them last, and the language its target file names.
export async function GET() {
  if (!(await auth())) return new Response("sign in first", { status: 401 });
  const db = getDb();
  return Response.json(Object.fromEntries(readTargets().map((t) => [t.name, { ...db.settings(t.name), ...(t.language ? { fileLanguage: t.language } : {}) }])));
}

// Replaces one target's settings. The factory runs the commands, so only a person who may act can save, and a bad value is refused here
// rather than found by the next run. An empty factoryFile clears it, and the factory reads .factory.yml from the repo again.
// autoMerge, when given, sets the target's auto_merge switch in the same write.
export async function PUT(req: Request) {
  const user = await controlUser(req);
  if (typeof user !== "string") return user;
  const body = (await req.json().catch(() => undefined)) as { target?: unknown; thresholds?: unknown; factoryFile?: unknown; language?: unknown; autoMerge?: unknown } | undefined;
  const { target, thresholds, factoryFile, language, autoMerge } = body ?? {};
  if (typeof target !== "string" || !readTargets().some((t) => t.name === target)) return new Response("target must be a target name", { status: 400 });
  const checked = checkThresholds(thresholds);
  if (checked.errors.length) return new Response(checked.errors.join("\n"), { status: 400 });
  // No language, or an empty one, means the target file's language.
  if (language !== undefined && language !== "" && !isLanguage(language)) return new Response("language must be en, es or de", { status: 400 });
  if (autoMerge !== undefined && typeof autoMerge !== "boolean") return new Response("autoMerge must be true or false", { status: 400 });
  if (factoryFile !== undefined && typeof factoryFile !== "string") return new Response("factoryFile must be text", { status: 400 });
  const text = factoryFile?.trim() ? factoryFile : undefined;
  if (text) {
    try {
      parseFactoryFile(text);
    } catch (e) {
      return new Response(`The .factory.yml commands are not valid: ${e instanceof Error ? e.message : e}`, { status: 400 });
    }
  }
  getDb().setSettings(target, { thresholds: thresholds as Record<string, unknown>, ...(text ? { factoryFile: text } : {}), ...(isLanguage(language) ? { language } : {}) }, user, autoMerge);
  return new Response(null, { status: 204 });
}
