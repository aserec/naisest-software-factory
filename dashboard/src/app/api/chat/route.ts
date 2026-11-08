import { callModel } from "software-factory/model-call";
import { auth } from "@/server/auth";
import { reply } from "@/server/chat";
import { chatModel } from "@/server/chat-model";
import { controlUser } from "@/server/control-user";
import { getDb } from "@/server/db-instance";

const SHOWN = 100;
// A page path: starts with a slash, no whitespace or newline (it goes into the model's prompt).
const okPath = (p: unknown): p is string => typeof p === "string" && p.length <= 200 && /^\/[^\s]*$/.test(p);

export async function GET(req: Request) {
  if (!(await auth())) return new Response("sign in first", { status: 401 });
  const path = new URL(req.url).searchParams.get("path");
  if (!okPath(path)) return new Response("path must start with / and be at most 200 characters", { status: 400 });
  return Response.json({ messages: getDb().chat(path, SHOWN) });
}

export async function POST(req: Request) {
  const user = await controlUser(req);
  if (typeof user !== "string") return user;
  const body = (await req.json().catch(() => undefined)) as { path?: unknown; text?: unknown } | undefined;
  const { path, text } = body ?? {};
  if (!okPath(path)) return new Response("path must start with / and be at most 200 characters", { status: 400 });
  if (typeof text !== "string" || text.length < 1 || text.length > 4000) return new Response("text must be 1 to 4000 characters", { status: 400 });
  const db = getDb();
  db.addChatMessage({ path, author: user, text });
  let status = 200;
  try {
    const choice = chatModel();
    await reply(db, path, user, (system, messages) => callModel(choice, process.env, system, messages, { maxTokens: 2000 }));
  } catch (e) {
    // Any failure (the model, the targets dir, the seams file) shows in the chat, so the person sees why there is no answer.
    db.addChatMessage({ path, author: "agent", text: `The model call failed: ${String(e).slice(0, 300)}` });
    status = 502;
  }
  return Response.json({ messages: db.chat(path, SHOWN) }, { status });
}
