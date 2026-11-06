import { KIND_TEXT, sendCard } from "../teams";
import type { Chat, Notice } from "../seams";

// Slack mrkdwn treats &, < and > as markup, so a title like "<b>" or "a & b" would break the message.
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// The message for a Slack incoming webhook: the same words as the Teams card, with an Open link.
export function buildSlackMessage(kind: Notice, title: string, lines: string[], url: string): object {
  return { text: [`*${KIND_TEXT[kind]}: ${esc(title)}*`, ...lines.map(esc), `<${url}|Open>`].join("\n") };
}

// The Slack adapter. The webhook URL is a secret; sendCard keeps it out of errors.
export function makeSlackChat(webhookUrl: string, fetchFn: typeof fetch = fetch): Chat {
  return { notify: (k, t, l, u) => sendCard(webhookUrl, buildSlackMessage(k, t, l, u), fetchFn, "Slack") };
}
