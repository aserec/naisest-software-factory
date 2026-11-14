// The Teams relay (docs/adr/2026-11-06-dashboard-relays-teams-messages.md). The writer and its reader sit side by side.
// The dashboard's Teams bridge posts a Teams message on a work item as the relay bot, a tracker user below Developer, so the
// comment itself never counts. A person confirms it with a 👍 on the tracker. Each 👍 counts as that person's own comment
// with the relayed text, at the time of the 👍, and the usual rules apply to it: trusted() for the author, the injection check.
// The tracker's login proves who confirmed, so a stolen relay token can only post comments nobody confirms.
// A leaf with no imports: the dashboard imports it too. Comment is seams.ts's Comment, written out.
type PersonRef = string;
type Comment = { author: PersonRef; byFactory: boolean; body: string; at: string; relayed?: true };

const HEAD = "relayed by the Teams bridge";
// The zero-width space the relay puts into `@factory`, so the relay comment itself is no request.
const BROKEN = "@​factory";

// The message as plain text: the @mention of the webhook gone, Teams' HTML removed.
export const plainText = (html: string) =>
  html
    .replace(/<at>.*?<\/at>/gis, "")
    .replace(/<br\s*\/?>|<\/(p|div)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .trim();

// Every line quoted, so no line is a GitLab quick action or an `@factory stop`, and `@factory` broken so no webhook reads a request.
export const relayText = (from: string, text: string) =>
  `**Teams message from ${from.replace(/[\r\n*_`<>[\]]/g, " ").trim() || "someone"}**, ${HEAD}. A member with Developer rights adds 👍 to this comment for the factory to act on it.\n\n` +
  text.replace(/@factory/gi, BROKEN).split("\n").map((l) => `> ${l}`).join("\n");

// The text people see quoted in a relay comment, or undefined when the body is not one.
export function relayedText(body: string): string | undefined {
  const cut = body.indexOf("\n\n");
  if (cut < 0 || !body.slice(0, cut).includes(HEAD)) return undefined;
  const lines = body.slice(cut + 2).split("\n");
  if (lines.some((l) => !l.startsWith(">"))) return undefined;
  return lines.map((l) => l.replace(/^> ?/, "")).join("\n").replaceAll(BROKEN, "@factory");
}

// The comments a relay comment counts as: one per 👍, from the person who gave it. A 👍 from before the comment's last edit
// does not count, so a relay bot that edits a confirmed comment needs a new 👍 for the new text.
export function confirmedRelays(c: { body: string; editedAt: string }, approvals: { by: PersonRef; at: string }[]): Comment[] {
  const body = relayedText(c.body);
  if (body === undefined) return [];
  return approvals.filter((a) => Date.parse(a.at) >= Date.parse(c.editedAt)).map((a) => ({ author: a.by, byFactory: false, body, at: a.at, relayed: true }));
}

// A tracker's comments, newest first, with the relay comments' 👍 added as comments, only those after `since`.
export function withRelays(comments: Comment[], relayed: Comment[], since?: string): Comment[] {
  const after = (l: Comment[]) => l.filter((c) => !since || Date.parse(c.at) > Date.parse(since));
  return relayed.length === 0 ? after(comments) : after([...comments, ...relayed]).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
