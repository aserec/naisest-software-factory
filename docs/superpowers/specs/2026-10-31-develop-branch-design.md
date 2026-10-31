# Develop branch: design

Date: 2026-10-31. Builds on [2026-10-28-software-factory-design.md](2026-10-28-software-factory-design.md) and [2026-10-29-swappable-modules-design.md](2026-10-29-swappable-modules-design.md).

## 1. Why

Today the factory merges straight into the target's GitLab default branch, which is `master` for react_frontend. That is too risky now. A bad merge reaches the branch that releases ship from.

The team moves to a classic git flow:

1. `develop` collects every change between two releases: the factory's changes and the team's own work.
2. Feature branches start from `develop` and merge back into `develop`.
3. A person cuts a release branch from `develop`, fixes what the release needs on that branch, then merges it into both `master` and `develop`.
4. This repeats for every release.

The factory works only against `develop`. Only low-risk changes merge without a person. Every other change waits for a person to press Merge.

## 2. Goals

1. The factory uses `develop` for everything it uses the default branch for today. It clones `develop` in triage and prepare patch, it opens merge requests against `develop`, verify watches the `develop` pipeline, and a revert merge request targets `develop`.
2. `master` stays the GitLab default branch of react_frontend. The branch the factory uses is set per target in `targets/<name>.yml`.
3. A change merges without a person only under today's merge rule (`docs/how-it-works.md`, "The merge rule"). The rule does not change.
4. The factory squash merges an auto merge. The squash commit title starts with `[AM] `, followed by a conventional commit title. The commit body explains the change in detail.
5. An auto merge leaves exactly one commit on `develop` and no merge commit, so the history stays a straight line. When the factory branch is behind `develop`, the factory rebases it before it merges.
6. Every other change waits for a person. The person reviews it, rebases it as the team does today, and presses Merge in GitLab. An approval no longer starts anything.
7. After a person merges, the finish pipeline runs as it does today for a manual merge. Apply skips, verify checks the `develop` pipeline, and result saved closes the ticket.

## 3. Non-goals

- Release branches. People create them, change them and merge them into `master` and `develop` by hand. The factory never reads or writes `master`.
- Hotfix branches from `master`. A fix for a production error goes through `develop` and reaches `master` with the next release. This includes watcher tickets.
- Making `develop` the GitLab default branch. The user decided `master` stays the default.
- Renaming the `factory_needs_approval` label. It keeps its name and now means "waits for a person to merge".
- A commit message for a person's merge. The person writes or accepts it in GitLab.

## 4. Anti-goals

The work fails, even if it runs, if any of these hold:

1. The factory merges into `master`, or opens or updates a merge request that targets `master`.
2. A change that needed a person lands without a person pressing Merge.
3. A commit carries `[AM]` although the factory did not merge it alone.
4. The agent's commit message carries `[skip ci]` or `[ci skip]`, so GitLab skips the `develop` pipeline that verify waits for.
5. A rebase lets code land that the code review and the risk check did not see.
6. The factory merges a rebased change before the merge request pipeline is green on the rebased commit.

## 5. Constraints

- The CodeHost seam stays swappable (`factory/seams.ts`). GitLab details stay in `factory/gitlab.ts` and `factory/adapters/gitlab-code-host.ts`.
- `GitLab.getProject().defaultBranch` keeps its other use. `decisionJob` checks that a build pipeline ran on the factory project's own default branch. That check is about the factory repo and does not change.
- The GitLab merge API takes `squash: true` and `squash_commit_message`. GitLab refuses or ignores `squash` when the project's squash setting is "Do not allow", so react_frontend must allow squash.
- One commit with no merge commit needs the project merge method "Fast-forward merge" together with squash. With that method, GitLab refuses to merge a branch that is behind the target branch. A rebase is the only way through.
- The merge method is a project setting in GitLab, not a branch setting. It applies to merges into `master` too, including release merges. The team rebases today, so react_frontend may already use it. A person checks this at go-live.
- The GitLab rebase API is `PUT /projects/:id/merge_requests/:iid/rebase`. It runs in the background. The merge request shows `rebase_in_progress` while it runs and `merge_error` when it fails. A rebase that hits a conflict fails and changes nothing.
- The merge request description keeps the line `Factory run <n>: <url>`. The event step reads it to find the build run.
- The merge request description goes through `noQuickActions`, as today. The commit message is agent text and lands in the description.

## 6. Design

### 6.1 The target's branch

`targets/<name>.yml` gets a required field `baseBranch`. react_frontend sets `baseBranch: develop`. The target schema in `factory/config.ts` validates it as a non-empty string.

`CodeHost.defaultBranch()` becomes `CodeHost.baseBranch()`. The GitLab code host returns the target's `baseBranch` and stops reading the project's default branch for this. Every current caller of `defaultBranch()` moves to `baseBranch()`: the clone in `triage.ts` and `prepare-patch.ts`, the merge request target in `openChange`, the pipeline in `verify.ts`, and the base and target of `revertMerge`.

### 6.2 The commit message

The author agent writes `run/commit-message.md`. `prompts/prepare.md` asks for it at the end of the work. `prompts/fix.md` asks the author to rewrite it after every fix, so the message matches the final diff.

The format follows the user's example:

```
feat(dashboard): add chat widget to registry

- Add chat widget component to packages/ui.
- Add stories in Storybook for the component.
- ...
```

The first line is a conventional commit title. The body is a bullet list that explains what changed, where, why, and which tests cover it. The user wants a lot of explanation, so the prompt asks for a full list. It does not ask for a short summary.

Code reads the file in one function next to `changeText` in `factory/steps/precommit-gate.ts`. That function does these things:

1. It removes `[skip ci]` and `[ci skip]` from the whole message, with the same rule as `noSkipCi`.
2. It removes a leading `[AM]` from the title. Only apply adds that mark.
3. It checks the title against the conventional format: a type from `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore` or `revert`, an optional scope in parentheses, an optional `!`, then `: ` and a summary. The title is at most 72 characters.
4. If the file is missing, or the title fails the check, the title falls back to the ticket title. The agent's body stays if it has one.
5. It adds closing lines under the body: links to the ticket and the factory run, and the AI line.

The function returns the title and the full message without `[AM]`. The merge request link does not exist yet when the branch commit is made, because `commitAndPush` runs before `openChange`. Apply adds that link to the squash message only.

### 6.3 Where the message goes

- **Branch commit.** `commitAndPush` in the precommit gate uses the full message. Today it uses `<ticket title> (#<id>)`. A person who merges without squash then lands this text.
- **Merge request.** The merge request title is the conventional title. The description shows the full message in a section named "Commit message", right below the `Factory run` line. The "Proof" section from the change-proof design and the changed-tests note go below it. The secret scan in the precommit gate already covers the description, so it covers the message. The decision step reopens the merge request on a resume with the same text.
- **Auto merge.** Apply passes `[AM] ` plus the full message to `CodeHost.merge`. The GitLab code host calls the merge API with `squash: true` and `squash_commit_message` set to that text. With the fast-forward method, that squash commit is the only commit that lands. The message saved for the merge is the one that was current at the reviewed commit, read from the record or from the run's clone. The builder picks which.

The branch slug keeps using the ticket title.

### 6.4 Rebase before an auto merge

Today apply waits for a green pipeline on the reviewed commit and merges exactly that commit. Under git flow, people and other factory runs merge into `develop` all the time, so the factory branch is often behind when apply runs. Apply changes as follows:

1. Apply first checks that the merge request head is still the reviewed commit, `risk-check.headSha`. If someone pushed to the branch, apply blocks.
2. If the branch is behind `develop`, apply asks GitLab to rebase it and waits until the rebase ends.
3. If the rebase fails, for example on a conflict, apply sends the change to a person the same way the decision step does: label `factory_needs_approval`, a comment on the merge request that asks for a rebase by hand and a merge, the assignee and the Teams card. The person's merge then runs verify and closes the ticket like any other human merge. This is the user's decision.
4. After the rebase, apply checks that the rebased change is the reviewed change. For each file, the added and removed lines must be the same as at the reviewed commit. The context around them may differ. If anything else differs, apply blocks. This closes anti-goal 5 and covers the time between the rebase and the next read of the head.
5. Apply waits for a green merge request pipeline on the rebased head, then merges that head with squash. The `sha` it passes is the rebased head, so GitLab refuses the merge if the branch moved again.
6. If `develop` moves again before the merge, GitLab refuses it, and apply goes back to step 2. After 3 rebases, apply sends the change to a person as in step 3. Each rebase starts a new merge request pipeline.

The record saves each rebased head next to the reviewed one, so a person can see what landed. Verify is unchanged. It checks the `develop` pipeline on the commit the merge returned, which is the squash commit.

`CodeHost` gets the calls apply needs for this: one that rebases a change and reports success or failure, and one that returns the change's per-file diff at a commit. The names and the shapes are the builder's call. The fakes in `factory/fakes.ts` and `factory/steps/test-helpers.ts` get the same calls.

### 6.5 Human merges

- The tracker's `parseEvent` stops returning `approved`. GitLab still sends approval events. They come back as `ignored`.
- `FactoryEvent` drops the `approved` kind. `changeEvent` in `factory/steps/event.ts` handles `merged` only, with today's checks: not the bot, a trusted actor, and the ticket is `needs_approval`.
- `CodeHost.approvedByTrusted` goes away, with `GitLab.approvedBy` if nothing else uses it, and their fakes and tests.
- Apply merges only when the decision is `auto`. Any other decision without `skipApply` blocks. That case should not happen anymore, so the block is a guard.
- Before it merges, apply checks that the merge request's target branch is the target's `baseBranch`. If not, apply blocks and does not merge. `Change` gets a `target` field for this.
- The decision step's comment changes from "needs a person to approve it" to "needs a person to review and merge it". The Teams card text changes the same way.

### 6.6 Docs

- `docs/how-it-works.md` gets a short "Branches" section that describes the git flow from section 1. It updates steps 3, 8 and 9, the finish pipeline trigger, "Approvals and manual merges" and the label table, so they say `develop`, human merge, rebase before an auto merge and `[AM]` squash. The line "It merges the exact commit that was reviewed" becomes "It merges the reviewed change, rebased onto `develop` when needed, after a green pipeline on the rebased commit".
- `docs/add-a-repo.md` lists `baseBranch` among the fields of `targets/<name>.yml`, and adds the GitLab settings from section 7.

## 7. Go-live steps for a person

These steps change GitLab, so a person does them. The builder writes them into `docs/go-live.md` and `docs/add-a-repo.md`.

1. Create `develop` in react_frontend from `master`.
2. Protect `develop`. Give the bot merge rights on `develop`. On Premium, remove the bot's merge rights on `master`. On Free, the bot is a Maintainer and can still merge into `master`, so the apply check in 6.5 is the only guard.
3. Set the project's merge method to "Fast-forward merge", and the squash setting to "Allow", "Encourage" or "Require". The merge method applies to `master` too.
4. Give `develop` no required approval rule that applies to factory merge requests. The bot cannot approve its own merge request, so a required approval makes every auto merge fail.
5. Check that react_frontend's CI runs a branch pipeline on pushes to `develop` and a merge request pipeline for merge requests that target `develop`. Without the branch pipeline, verify waits an hour and blocks every merge.
6. Before the new factory version runs, handle the open factory merge requests that target `master`. Retarget each one to `develop`, or close it and add `factory_ready` to its ticket again. A person who merges one into `master` after the switch gets a block from verify, because verify looks for the commit on `develop`.

## 8. Calls made without the user

These are the designer's calls. The user did not decide them.

1. The field is named `baseBranch` and is required, with no fallback to the GitLab default branch.
2. `CodeHost.defaultBranch()` is renamed `baseBranch()`.
3. A missing or bad commit title falls back to the ticket title. The merge goes on.
4. The merge request title is the conventional title, and the description shows the full message.
5. The branch commit uses the full message, so a person's merge commit carries it too.
6. The commit title has no `(#<id>)` suffix. The ticket link is in the closing lines.
7. Apply checks the merge request's target branch before it merges.
8. A person who retargets a factory merge request to `master` and merges it gets no special handling. Verify finds no `develop` pipeline for the commit and blocks after an hour.
9. The label `factory_needs_approval` keeps its name.
10. The branch commit leaves out the merge request link. Only the `[AM]` squash message carries it. A second push after the merge request opens would change the reviewed sha and start a second pipeline.
11. This work does not depend on the change-proof work. Whichever lands second merges its `changeText` changes with the other's.
12. `develop` has no required approval rule for factory merge requests. This is a go-live step, not code.
13. The factory rebases through the GitLab API. It does not clone the branch in the finish pipeline.
14. A rebased change counts as the reviewed change when each file's added and removed lines match. A green pipeline on the rebased head is still required.
15. Apply rebases at most 3 times, then blocks.
16. A failed rebase blocks. The factory does not try to resolve conflicts.

## 9. Left to the builder

- Where apply reads the commit message from: the record, saved by the precommit gate, or the run's clone.
- The exact text of the closing lines and of the prompt lines.
- How apply learns that the branch is behind `develop`, for example `detailed_merge_status` or `diverged_commits_count`.
- How long apply waits for one rebase before it counts as failed.
- Test layout, as long as the flow tests in `factory/steps/flow.test.ts` cover the auto merge with `[AM]` and squash, an ignored approval, a human merge into `develop`, apply blocking on a wrong target branch, a rebase then merge, a failed rebase, a rebased diff that differs, a branch someone pushed to, and the limit of 3 rebases.
