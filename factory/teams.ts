import type { Notice } from "./seams";

const KIND_TEXT: Record<Notice, string> = { needs_info: "Needs info", needs_approval: "Needs approval", blocked: "Blocked", done: "Done", waiting: "Waiting", watcher_ticket: "New watcher ticket" };

// Adaptive Card message for a Teams Workflows webhook.
export function buildCard(kind: Notice, title: string, lines: string[], url: string): object {
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            { type: "TextBlock", text: `${KIND_TEXT[kind]}: ${title}`, weight: "Bolder", size: "Medium", wrap: true },
            ...lines.map((text) => ({ type: "TextBlock", text, wrap: true })),
          ],
          actions: [{ type: "Action.OpenUrl", title: "Open", url }],
        },
      },
    ],
  };
}

// The webhook URL holds a secret, so it never goes into an error.
export async function sendCard(webhookUrl: string, card: object, fetchFn: typeof fetch = fetch): Promise<void> {
  let res: Response;
  try {
    res = await fetchFn(webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(card) });
  } catch {
    // Drop the original error: its message can hold the URL.
    throw new Error("Teams webhook request failed");
  }
  if (!res.ok) throw new Error(`Teams webhook failed with status ${res.status}`);
}
