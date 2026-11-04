// The rules for a `@factory` request on a change: which comments are requests, and where the factory stopped reading.
import type { Comment, FactoryState, PersonRef } from "./seams";

const COMMANDS = ["@factory stop", "@factory resume"];
const MENTION = /(^|[^\w@.-])@factory(?![\w-])/i;

export function isRequest(body: string): boolean {
  if (body.split("\n").some((l) => COMMANDS.includes(l.trim().toLowerCase()))) return false;
  return MENTION.test(body);
}

export const cursorLine = (at: string) => `Requests read up to: ${at}`;

// The line on the factory's comment that set a blocked or needs_info work item ready for a person's request.
export const readyForLine = (person: string) => `Ready for the request of: ${person}`;
export const readyForOf = (body: string): string | undefined => /^Ready for the request of: (\S+)$/m.exec(body)?.[1];

// The cursor of the newest factory comment that has the line. Comments by people are ignored.
export function readCursor(comments: Comment[]): string | undefined {
  const withLine = comments.filter((c) => c.byFactory).map((c) => ({ at: c.at, cursor: /^Requests read up to: (\S+)/m.exec(c.body)?.[1] }));
  return withLine.filter((c) => c.cursor).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]?.cursor;
}

// The time of the factory's newest comment in the list, if it has one.
export const newestByFactory = (comments: Comment[]): string | undefined => comments.filter((c) => c.byFactory).reduce<string | undefined>((t, c) => later(t, c.at), undefined);

export const later = (a: string | undefined, b: string | undefined): string | undefined =>
  a === undefined || b === undefined ? (a ?? b) : Date.parse(b) > Date.parse(a) ? b : a;

const WHAT: Partial<Record<FactoryState, string>> = {
  stopped: "Comment `@factory resume` to continue the run. The factory takes up this request once its change waits for a person.",
  waiting: "The run waits for the author agent's usage limit. The factory continues it within the hour and takes up this request once its change waits for a person.",
  ready: "The run starts soon. Write the request again once the change waits for a person.",
  done: "This work is done. Open a new work item for more.",
};

export function stateReply(author: PersonRef, state: FactoryState | undefined): string {
  const what = (state && WHAT[state]) ?? "The factory has not started work here. Add factory_ready to start.";
  return `@${author} The factory takes @factory requests only while its change waits for a person (factory_needs_approval). ${what}`;
}
