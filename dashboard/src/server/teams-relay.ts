// The text the Teams bridge posts. A leaf with no imports, so the factory's tests can check how the factory treats a relay.

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
  `**Teams message from ${from.replace(/[\r\n*_`<>[\]]/g, " ").trim() || "someone"}**, relayed by the Teams bridge. The factory does not act on it.\n\n` +
  text.replace(/@factory/gi, "@\u200Bfactory").split("\n").map((l) => `> ${l}`).join("\n");
