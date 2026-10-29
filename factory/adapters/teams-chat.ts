import { buildCard, sendCard } from "../teams";
import type { Chat } from "../seams";

// The Teams adapter. The webhook URL is a secret; sendCard keeps it out of errors.
export function makeTeamsChat(webhookUrl: string, fetchFn: typeof fetch = fetch): Chat {
  return { notify: (k, t, l, u) => sendCard(webhookUrl, buildCard(k, t, l, u), fetchFn) };
}
