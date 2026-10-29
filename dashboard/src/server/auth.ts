import { createHash, timingSafeEqual } from "node:crypto";

// Hash both sides so the compare has equal lengths and the token length does not leak.
const digest = (s: string) => createHash("sha256").update(s).digest();

export function factoryAuthorized(req: Request): boolean {
  const token = process.env.FACTORY_DASHBOARD_TOKEN;
  if (!token) return false;
  const given = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
  return given !== undefined && timingSafeEqual(digest(given), digest(token));
}
