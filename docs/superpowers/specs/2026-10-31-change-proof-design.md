# Change proof: design

Date: 2026-10-31. Builds on [2026-10-28-software-factory-design.md](2026-10-28-software-factory-design.md) and [2026-10-29-swappable-modules-design.md](2026-10-29-swappable-modules-design.md).

## 1. Why

A person who approves a factory merge request reads the ticket first: its acceptance criteria, when and where the problem happens, and any screenshots. Then they compare that with the code and with proof of the result. Today the merge request carries no proof of the result, so the person has to guess whether the change does what the ticket asked.

The goal: every factory change carries proof that it does what the ticket asked.

- When the change is expected to look different, the proof is screenshots of each affected screen, before and after the change.
- When it is not, the proof is tests that fail on the old code and pass on the new code.

Two readers use the proof:

1. The person who approves the merge request.
2. The AI code reviewer in step 4. It judges each screen against the ticket and can block the change or send it to a person.

## 2. Goals

1. The author agent takes "before" screenshots of the affected screens before it writes any code, then "after" screenshots of the same screens once the change is done.
2. Screenshots are taken only when the change is expected to look different. Other changes carry test proof only.
3. The code reviewer sees the screenshots next to the ticket and the diff, and gives each screen one verdict: `matches`, `does_not_match` or `unsure`.
4. The merge request description gets a "Proof" section, grouped by screen, with each screen's before and after images, its verdict and one reviewer note. Test proof sits below the screens.
5. The reviewer never passes a change it cannot prove. An `unsure` verdict, or missing proof, sends the change to a person and stops it from merging alone. This holds for test proof too: a change with no visual difference expected and no test that fails before and passes after goes to a person (user decision 10).
6. Changes that merge without a person carry the same "Proof" section, as a record.

## 3. Non-goals

- Screenshots for targets with no `preview` command in `.factory.yml` (section 7). They get test proof only.
- Pixel diffs or visual regression tooling. The reviewer judges the images against the ticket.
- A mapping from acceptance criteria to screenshots. The user chose proof grouped by screen, judged against the ticket as a whole.
- Asking for acceptance criteria when a ticket has none. This follows from user decision 7: each screen is judged against the ticket as a whole, so proof by screen does not need them.
- Videos or recordings.
- Using Jev to judge the screenshots. The Jev client sends text to Berget and gets back probabilities, so it cannot look at an image.
- Obscura as the browser. We tried it on `react_frontend` in mock mode: the dashboard, documents and settings pages at 1280 x 800, driven by Playwright. Chromium rendered all three pages. Obscura, reached over CDP, showed only the "Opening your workspace" loading screen on all three. In a second run React loaded with no page errors, but the loading screen stayed. Playwright's wait for the page also failed at once over Obscura's CDP, so that run did not show whether more time would help. Obscura never rendered the app, so the browser is Chromium (user decision 12).

## 4. Anti-goals

The work fails, even if it runs, if any of these hold:

- **A false pass.** The reviewer answers `matches` for a screen that does not show what the ticket asked, and the change merges without a person. The user named this as the failure they fear most. Every unclear case must go to a person.
- An agent writes to GitLab. Agents save files. Factory scripts upload images and write the description, as they do for every other write.
- A missing screenshot, a dev server that does not start or a browser crash blocks the run. These cases send the change to a person with a reason. They never stop the build.
- A failed image upload blocks the run. The script tries each upload again up to 3 times. If every try fails, it still opens the change, writes "image upload failed" in the "Proof" section and sends the change to a person with that reason (user answer on the plan).
- Screenshot code leaks into the steps as tool words, such as `playwright` or `chromium`. The steps see proof files and verdicts only.

## 5. Decisions the user made

1. The "before" shots come from the code before the change, taken by the author agent as its first action, not from the main branch.
2. The agent starts the target app with `pnpm dev` and `NEXT_PUBLIC_MOCK_ALL=true`, so the whole app runs on mocked data. In `react_frontend`, `scripts/dev.mjs` then skips the backend and the sign-in, and the app runs at `http://localhost:3000`.
3. The AI code reviewer also judges the proof and may block the change.
4. Jev or a plain model as the judge was left to my call (section 11).
5. The false pass is the error to avoid (section 4).
6. For a change with no visual part, the proof is a test that fails on the old code and passes on the new code.
7. The "Proof" section is grouped by screen, and each screen has its own verdict judged against the ticket as a whole (mockup B2).
8. Screenshots are taken only when a visual difference is expected.
9. A new screen has no "before" image. Its row says "new screen".
10. Test proof is enforced. A change with no visual difference expected needs at least one test recorded as failing before and passing after, or it goes to a person. The user accepted that config changes and refactors with no new test then always wait for a person.
11. It must work in both places: the local trial on macOS (`local-run.sh`) and the GitLab CI runner on Linux.
12. The browser is Chromium, through the Playwright that `react_frontend` already has. The user asked to try Obscura first and to keep Chromium unless it worked. It did not render the app (section 3).

## 6. The flow

The ten steps in `docs/how-it-works.md` stay. Three of them change.

### 6.1 Prepare patch (step 3)

The author prompt (`prompts/prepare.md`) gets these rules:

1. Decide from the ticket whether the change is expected to look different. If it is not, skip to rule 4.
2. Before you change any code, start the app with the `preview` command from `.factory.yml`, open each screen the ticket names or the change will touch, and save a screenshot of each. At most 5 screens (my call). Use 1280 px width, and also any width the ticket names.
3. After the change passes lint, test and build, take the same screens again. Add a screen the change creates, marked as new.
4. For each test you write for the ticket, save its output before you change the code (it fails) and after (it passes).
5. Write everything to `run/proof/` (section 8). If a step fails, such as the app not starting, write why and go on with the ticket.

The agent drives Chromium with Playwright through the shell (user decision 12), so this works the same under Claude Code and Pi. `react_frontend` already depends on Playwright, and `@playwright/cli` is a root dev dependency.

### 6.2 Code review (step 4)

The reviewer gets the screenshots from `run/proof/` next to the ticket and the diff. For each screen it answers one verdict and one short note:

| Verdict | Meaning | What happens |
| --- | --- | --- |
| `matches` | The "after" shot shows what the ticket asks for this screen. | Nothing. |
| `does_not_match` | The "after" shot contradicts the ticket. | A blocking finding. The author fixes it inside the 3 review rounds that exist today. |
| `unsure` | The reviewer cannot tell from the images. | Not blocking. The decision step sends the change to a person. |

The reviewer also answers `unsure` when the diff looks like a visual change but `run/proof/` holds no screens, and when a "before" shot does not show the problem the ticket describes. Mocked data can hide a bug, and this rule catches that case.

The review prompt (`prompts/review.md`) tells the reviewer to answer `matches` only when the image shows it, and `unsure` in every other case.

When the author fixes a finding in the review or gate loop and the change is expected to look different, the fix prompt (`prompts/fix.md`) tells it to take the "after" shots again. The reviewer always judges the shots that match the current code.

### 6.3 Precommit gate (step 5), where the merge request opens

`changeText` in `factory/steps/precommit-gate.ts` builds the merge request description. It gets the "Proof" section (section 9). The script uploads each image to GitLab first and links the uploaded files in the section. The secret scan that runs before the push also scans the proof text.

### 6.4 Decision (step 7)

`decideByChecks` in `factory/steps/decision.ts` adds a `needs_approval` reason for each of these:

- a screen with the verdict `unsure`;
- a change with a visual difference expected but no screens in `run/proof/`, with the reason the agent wrote;
- a reviewer model that cannot read images, while screens exist (section 10);
- a change with no visual difference expected and no test in `proof.json` that failed before and passed after. Code checks this from the exit codes in the manifest, not the reviewer. A missing or invalid `proof.json` counts as no proof.

## 7. Target config

`.factory.yml` in the target gets two optional keys (names are my call):

```yaml
preview: NEXT_PUBLIC_APP_ENV=development NEXT_PUBLIC_MOCK_ALL=true pnpm dev
previewUrl: http://localhost:3000
```

`NEXT_PUBLIC_APP_ENV=development` is required. The `.env*` files of `react_frontend` are not committed, and `apps/web/src/lib/mock/mock-all.ts` refuses mock mode when that variable names no allowed environment. On a developer machine, a local `.env.development` sets it.

`commandsSchema` in `factory/config.ts` accepts them. The prepare step already reads the commands before the agent runs and saves them in the record, so the agent cannot change them. A target with no `preview` gets test proof only.

`.factory.yml` is a protected path in `targets/react_frontend.yml`, so a person adds these keys to `react_frontend` by hand.

## 8. Proof files

The agent writes to `run/proof/` in the target clone. The `run/` folder is already excluded from git by `factory/steps/repo.ts`, and the CI artifacts already carry it from job to job. The agent already writes `run/test-changes.md` the same way.

The layout below is a sketch. The builder picks the exact names, but keeps one manifest that the steps read:

```
run/proof/
  proof.json          screens, tests, and any failure note
  before-<screen>.png
  after-<screen>.png
```

`proof.json` holds, for each screen, its name, the URL or steps to reach it, the width, whether it is new, and the two image files. For each test, it holds the test name, the command, the exit code and the end of its output before and after. A `note` field holds the reason when the agent could not take the shots.

The steps treat the manifest as data from the agent: they validate it, cap its size, and ignore files outside `run/proof/`.

## 9. The "Proof" section on the merge request

This is mockup B2:

```
## Proof

### Screen 1: profile page, 375 px: matches
| Before | After |
| <image> | <image> |
Reviewer: the Save button is now inside the screen.

### Screen 2: settings page, 1280 px: new screen
| After |
| <image> |
Reviewer: ...

### Tests
- profile-save: failed before, passes after
```

When there are no screens because no visual difference is expected, the section holds only the tests. When the shots failed, it says why.

## 10. Runner and sandbox

Both places must work (user decision 11).

- **Local trial on macOS.** The agent's sandbox allows local port binding only when `FACTORY_PNPM_STORE` is set (`sandboxSettings` in `factory/steps/repo.ts`). The dev server needs it whenever the target has a `preview` command.
- **CI on Linux.** The CI jobs and `targets/react_frontend.yml` use the plain `node:22` image today, not the `runner/Dockerfile` image. The plan moves them to the runner image and adds Chromium to it. The build check at the end of the Dockerfile checks that Chromium runs.
- In both places, the agent runs inside a sandbox. The dev server must listen on localhost, and Chromium must reach it. Claude Code sandboxes each shell command on its own, so a dev server started in one command may not be reachable from the next. The builder confirms this works under the macOS sandbox and under bubblewrap.
- The reviewer must read images. Today the Pi reviewer runs with `--print --no-tools` and gets the prompt as text (`factory/adapters/pi.ts`). The builder finds how each harness passes images to the model and whether each reviewer model in `router.yml` reads images. When a harness or model cannot, the review gives every screen the verdict `unsure`, and the change goes to a person. It never fails open.
- If the trial reviewer `z-ai/glm-5.3-flash` cannot read images, the plan switches the reviewer to a model that can. `loadRouter` requires it to be of a different family from the author. The user wants the AI to judge the screens (section 5, decision 3), so a reviewer that sends every visual change to a person does not meet the goal. Pick a model the configured providers serve; ask the user only if none of them reads images.

## 11. My calls

These are my decisions, not the user's. The user should check them.

1. The judge is the existing code reviewer in step 4, with images added, not a new step and not Jev.
2. At most 5 screens per change.
3. Width 1280 px, plus any width the ticket names.
4. The `.factory.yml` keys are `preview` and `previewUrl`.
5. The agent saves files only. The precommit gate step uploads the images and writes the section.
6. Failed shots never block a run. They send the change to a person.
7. After a fix, the author takes the "after" shots again.
8. Test proof is what the agent recorded. The factory does not run the tests on the old code itself. The reviewer sees the output and the diff. `ponytail:` a factory run of the new tests on the base commit would make this proof stronger, add it if agent-reported output proves unreliable.

## 12. Left to the builder

- Exact types for the proof manifest and the reviewer's verdict output, kept in factory words.
- How the code host seam uploads a file. The GitLab adapter can use the project uploads API.
- How images reach the reviewer for each harness.
- The Chromium setup in the runner image and the sandbox settings it needs.
- Test cases, in the style of `factory/steps/flow.test.ts`, for at least: a `does_not_match` verdict blocks; an `unsure` verdict sends the change to a person; a run with a visual difference expected but no screens sends the change to a person; a change with no visual difference and a test that failed before and passed after merges on the existing rules; the same change with no such test goes to a person; the "Proof" section appears in the description.
