// Every line the factory writes into a change and reads back.

// The CI skips the pipeline of a commit or change whose title says so, and the hard rules need that pipeline.
// [AM] is the finish run's mark, so no text of the agent or the ticket keeps it. Repeat the replace:
// "[skip [ci skip]ci]" turns into "[skip ci]" after one pass. [ \t]* never eats a newline.
export const withoutMarks = (text: string): string => {
  const out = text.replace(/\[(skip ci|ci skip)\]/gi, "").replace(/\[AM\][ \t]*/gi, "");
  return out === text ? text.trim() : withoutMarks(out);
};

// The line that names the build run, in the commit message and in the change body.
// The finish run finds the build run's record through it (approval and manual merge paths).
export const runLine = (run: string | undefined, runUrl: string | undefined) => `Factory run ${run}: ${runUrl}`;
// No end anchor: a body edited in the web UI may end its lines in \r\n.
export const buildRunOf = (body: string): string | undefined => /^Factory run (\d+): /m.exec(body)?.[1];

// The squash commit message of the factory's own merge. [AM] marks it as the finish run's.
export const mergeMessage = (commitMessage: string, changeUrl: string | undefined) => `[AM] ${commitMessage}\nMerge request: ${changeUrl}`;
