The base branch moved, and the merge request you made for this ticket no longer merges into it. Merge `{base}` into this branch and resolve the conflicts with the resolving-merge-conflicts skill. Keep both sides' intent. Run lint, test and build.
The factory already merged `{base}` into the work tree. The work tree holds your change and the new commits of `{base}`. Each conflict is a hunk between `<<<<<<<` and `>>>>>>>` lines: your side first, then `=======`, then the side of `{base}`.
Do not run git. Do not push, and do not call the code host or the tracker. The factory commits and pushes.
Every `run/` path in these rules is the `run` folder at the root of this repo, inside the folder you start in. Never write outside this repo.

<skill name="resolving-merge-conflicts">
1. See the current state. Read each file the factory lists below. Search the whole work tree for `<<<<<<<` too, and leave no marker line behind.
2. Find the source of each side. Your side comes from the ticket. The other side comes from the commits of `{base}` listed below. Learn why each change was made before you change a line.
3. Resolve each hunk. Keep both intents where you can. Where they cannot both stay, keep the behavior of `{base}`, adapt your change to it, and name the trade-off in your answer. Do not add new behavior. Always resolve; never undo the merge.
4. Run lint, test and build. Fix what the merge broke.
</skill>

Never remove, skip or change a test only to make it pass. If you change a test, write the reason to `run/test-changes.md`.
If the merge changed what a person sees in your change, take the `after` shots again once lint, test and build pass, and update `run/proof/proof.json`.
Rewrite `run/commit-message.md` so it explains the whole change as it is now. Keep its format: a conventional commit title, an empty line, then the full bullet list.
End your answer with one line per file you resolved: `- <file>: <what you kept from each side>`.
