# Change Proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every factory change carries proof that it does what the ticket asked: before and after screenshots judged by the reviewer when the change looks different, and a test that failed before and passes after when it does not. Anything unproven goes to a person.

**Architecture:** The author agent writes `run/proof/` (a `proof.json` manifest and PNG files). One new pure module `factory/proof.ts` parses the manifest, turns reviewer items into one verdict per screen, lists the reasons a change needs a person, and renders the "Proof" section. Code review sends the images to the reviewer through a new `HarnessJob.images` field; the precommit gate uploads them through a new `CodeHost.attach`; the decision step adds the proof reasons. The preview server and Chromium run inside the author's existing sandbox, with local port binding turned on only when the target has a `preview` command.

**Tech Stack:** TypeScript on Node 22, vitest, zod, the `pi` 1.4.0 and `claude` CLIs, `srt` (`@anthropic-ai/sandbox-runtime`), Chromium through `react_frontend`'s Playwright 1.62.1. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-31-change-proof-design.md` (builds on `2026-10-28-software-factory-design.md` and `2026-10-29-swappable-modules-design.md`).

## Global Constraints

- Verdicts are exactly `matches`, `does_not_match`, `unsure`. Any other text counts as `unsure`.
- At most 5 screens per change. Width 1280 px, plus any width the ticket names.
- `.factory.yml` keys are `preview` and `previewUrl`. A target with no `preview` gets test proof only.
- Agents save files only, under `run/proof/` with the manifest `run/proof/proof.json`. Factory scripts upload images and write the description. No agent writes to GitLab.
- A missing screenshot, a dev server that does not start, a browser crash, or an image upload that still fails after 3 retries never blocks a run: the change goes to a person with a reason.
- Never fail open: a harness or model that cannot read images gives every screen `unsure`.
- The manifest is agent data: validated, size-capped, and no file outside `run/proof/` is read.
- No tool words in `factory/steps/`: the existing list plus `playwright` and `chromium`.
- It works in both places: `local-run.sh` on macOS and the GitLab CI runner on Linux (user decision 11).
- The browser is Chromium (user decision 12). Not Obscura.
- Author and reviewer of one router row keep different model families (`loadRouter`).
- Test proof is what the agent recorded. The factory does not run the tests on the old code itself (spec 11.8).
- Spec section 5 user decisions stand as written.
- Simple English in comments, prompts and docs, short comments, smallest code that works.

## Review Focus

1. `proof.json` names an image that is a link or leaves `run/proof/` (`../../.git/config`, a link to `~/.ssh/id_rsa`): it is never read, never sent to the reviewer, never uploaded, and the screen is `unsure`. Tests in Tasks 1 and 3.
2. The reviewer says `matches` for a screen with no after image, or for a screen that is not new and has no before image; gives no item for a screen; or writes `Matches` or `yes`. Each of these is `unsure`. Test in Task 3.
3. Screen names or reviewer notes holding newlines, `|`, HTML or a `/merge` line: the Proof section shows them as one table-safe line with no quick action. Test in Task 5.
4. `proof.json` that is huge, not JSON, has 6 screens, or holds 50 KB test tails: it is invalid or cut, never a crash, and invalid counts as no proof. Test in Task 1.
5. A run continued at `risk-check` or `decision` opens the change again: same image links, no second upload, Proof section kept. Test in Task 5.

---

## File structure

| File | Responsibility |
|---|---|
| `factory/proof.ts` | New. Proof types, `parseProof`, `readProof`, `readImages`, `proofPrompt`, `screenVerdicts`, `proofReasons`, `proofSection`. Pure; factory words only. |
| `factory/proof.test.ts` | New. Unit tests for the above. |
| `factory/config.ts`, `factory/types.ts` | `preview`/`previewUrl` keys; `images` list per provider in `seams.yml`. |
| `factory/seams.ts` | `Provider.images`, `HarnessJob.images`, `HarnessJob.preview`, `Harness.images`, `Repo.readBytes`, `CodeHost.attach`. |
| `factory/adapters/pi.ts` | Images as `@file` arguments to the reviewer; image input in `models.json`; local binding and browser path for the author. |
| `factory/adapters/claude-code.ts`, `factory/agents.ts` | `images: false`; local binding when preview; browser path; `Finding` fields; `reviewerPrompt` proof block. |
| `factory/gitlab.ts`, `factory/adapters/gitlab-code-host.ts` | Project upload for `attach`. |
| `factory/steps/repo.ts` | `readBytes`. |
| `factory/steps/{code-review,decision,precommit-gate,prepare-patch,context}.ts` | Read and judge proof, add reasons, upload and render, preview flag. |
| `factory/fakes.ts`, `factory/steps/test-helpers.ts` | Fake `attach`, harness `images`, fake repo `readBytes`, world options `proof` and `images`. |
| `prompts/prepare.md`, `prompts/fix.md`, `prompts/review.md` | Proof rules for the author and verdict rules for the reviewer. |
| `runner/Dockerfile`, `.gitlab-ci.yml`, `factory/ci.test.ts`, `local-run.sh` | Chromium and the fixed browser path in both places. |
| `seams.yml`, `router.yml` | Which models read images; reviewer switch if the trial model cannot. |
| `docs/targets/react_frontend.factory.yml`, `docs/setup.md`, `docs/how-it-works.md` | The proposed keys, the image digest follow-up, the sandbox spike result, the changed steps. |

---

### Task 1: Target config keys and the proof manifest

**Files:**
- Modify: `factory/config.ts:53-59` (`commandsSchema`), `factory/types.ts:22` (`FactoryCommands`), `docs/targets/react_frontend.factory.yml`
- Create: `factory/proof.ts`, `factory/proof.test.ts`
- Test: `factory/config.test.ts`

**Interfaces:**
- Produces in `factory/types.ts`: `FactoryCommands` gains `preview?: string; previewUrl?: string`.
- Produces in `factory/config.ts`: `commandsSchema` gains `preview: z.string().min(1).optional()`, `previewUrl: z.string().url().optional()`, and a refine `!c.preview === !c.previewUrl` with the message `preview and previewUrl go together`. `parseFactoryFile` keeps throwing on a bad file.
- Produces in `factory/proof.ts`:

```ts
export const PROOF_DIR = "run/proof/";
export const PROOF_FILE = "run/proof/proof.json";
export interface ProofRun { exit: number; tail: string }
export interface ProofTest { name: string; command: string; before: ProofRun; after: ProofRun }
export interface ProofScreen { name: string; reach: string; width: number; isNew: boolean; before?: string; after?: string } // image names inside run/proof/
export interface Proof { visual: boolean; screens: ProofScreen[]; tests: ProofTest[]; note?: string } // visual: the agent expects the change to look different
export function parseProof(text: string | undefined): { proof?: Proof; error?: string };
export function readProof(readFile: (path: string) => string | undefined): { proof?: Proof; error?: string; raw?: string };
```

- `parseProof` rules (zod): `undefined` gives `error: "no run/proof/proof.json"`; text over 200_000 chars, text that is not JSON, more than 5 screens or more than 20 tests give an `error` naming the cause; image names must match `/^[a-z0-9][a-z0-9-]{0,60}\.png$/` (no slash, so only files directly in `run/proof/`); `screens` and `tests` default to `[]`, `isNew` to `false`; `width` is a positive integer. Transforms, not rejects: `name`, `reach`, `command` and `note` become one line (whitespace runs to one space); each `tail` keeps its last 1000 chars.
- `readProof` calls `readFile(PROOF_FILE)` inside try/catch (the real `readFile` throws on a link) and returns `{ error: "run/proof/proof.json is a link or leaves the clone" }` then; otherwise `{ ...parseProof(raw), raw }`.

- [ ] **Step 1: Write the failing tests** in `factory/proof.test.ts`:
  - `parseProof(VALID)` returns the manifest with `isNew: false` filled in. `VALID` = `{ visual: true, screens: [{ name: "list page", reach: "http://localhost:3000/list", width: 1280, before: "before-list-1280.png", after: "after-list-1280.png" }], tests: [{ name: "list-spinner", command: "pnpm test", before: { exit: 1, tail: "1 failed" }, after: { exit: 0, tail: "1 passed" } }] }`.
  - Review Focus 4: `parseProof(undefined).error` matches `/no run\/proof\/proof.json/`; `parseProof("x".repeat(200_001)).error` and `parseProof("{not json").error` are defined; 6 screens and 21 tests each give an `error`; a test whose `before.tail` is `"a".repeat(50_000) + "END"` parses with `tail.length === 1000` and ending `END`; a screen name `"list\npage"` parses as `"list page"`. None of these throw.
  - Review Focus 1: a screen with `after: "../../.git/config"`, `after: "sub/after.png"` or `after: "After.PNG"` gives an `error`.
  - `readProof(() => { throw new Error("Refused") }).error` matches `/link/`; `readProof(() => JSON.stringify(VALID)).raw` is that text.
  - In `factory/config.test.ts`: `parseFactoryFile(BASE + "preview: pnpm dev\n")` throws `/preview and previewUrl go together/`; `BASE + "preview: pnpm dev\npreviewUrl: not-a-url\n"` throws; `BASE + "preview: pnpm dev\npreviewUrl: http://localhost:3000\n"` returns both keys. `BASE` = `"install: i\nlint: l\ntest: t\nbuild: b\n"`.
- [ ] **Step 2: Run** `pnpm vitest run factory/proof.test.ts factory/config.test.ts`. Expected: FAIL, `../proof` not found and no refine.
- [ ] **Step 3: Implement** `factory/proof.ts` (parse, then transform) and the config change. Add the two keys from spec section 7 to `docs/targets/react_frontend.factory.yml`, with one comment line: `NEXT_PUBLIC_APP_ENV=development` is required because `.env*` files are not committed and `mock-all.ts` refuses mock mode without it.
- [ ] **Step 4: Run** `pnpm vitest run factory/proof.test.ts factory/config.test.ts && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add factory/proof.ts factory/proof.test.ts factory/config.ts factory/types.ts factory/config.test.ts docs/targets/react_frontend.factory.yml
git commit -m "feat(proof): add the preview keys and the proof manifest parser"
```

---

### Task 2: Images reach the reviewer

**Files:**
- Modify: `factory/seams.ts:95` (`Provider`), `:99` (`HarnessJob`), `:102` (`Harness`); `factory/config.ts:33-38` (`seamsSchema`) and `:77-82` (`loadSeams`); `factory/adapters/pi.ts:12-24` (`piModels`, `piArgs`) and `:100-116` (reviewer path); `factory/adapters/claude-code.ts:58-59`; `factory/fakes.ts:207-217` (`fakeHarness`); `seams.yml:11`; `factory/contracts/harness.real.test.ts:22`
- Maybe modify: `router.yml:4,8` (Step 6)
- Test: `factory/adapters/pi.test.ts`, `factory/config.test.ts`

**Interfaces:**
- Produces in `factory/seams.ts`:

```ts
export interface Provider { name: string; api: ApiStyle; baseUrl?: string; keyEnv: string; models: Record<string, string>; images?: string[] } // images: model ids that read images
export interface HarnessJob { /* existing fields */ images?: { name: string; data: Buffer }[] } // PNGs for the reviewer, in the order the prompt lists them
export interface Harness { readonly apis: ApiStyle[]; readonly images: boolean; run(job: HarnessJob): Promise<HarnessResult> } // images: the harness can pass images to a model
```

- `pi.images = true`; `claudeCode.images = false` (`ponytail:` Claude Code can take images through `--input-format stream-json`; add it when a claude-code reviewer is configured); `fakeHarness` has `images: true`.
- `seamsSchema` providers gain `images: z.array(z.string().min(1)).optional()`. `loadSeams` throws `seams.yml providers.<name>.images: model <id> is not in models` for an id missing from `models`.
- `piModels(choice)`: the model entry gets `input: ["text", "image"]` when `provider.images?.includes(model)`.
- `piArgs(provider: string, model: string, prompt: string, files: string[] = [])`: after `"--"` come `...files.map((f) => "@" + f)`, then the prompt (Pi 1.4.0 usage line: `pi [options] [--] [@files...] [messages...]`).
- Pi reviewer: writes each `job.images` entry to `join(dir, image.name)` in its temp dir and passes those absolute paths as `files`.

- [ ] **Step 1: Write the failing tests.**
  - `pi.test.ts`: `piArgs("tensorx", "m", "p", ["/t/a.png"]).slice(-3)` equals `["--", "@/t/a.png", "p"]`. `piModels` of a provider with `images: ["m"]` has `models[0].input` equal to `["text", "image"]`; without `images`, `input` holds no `"image"`. With `fakePi` whose body writes the byte count of each `@` argument's file to `<bin>/sizes`, a reviewer job with `images: [{ name: "after-list-1280.png", data: PNG }]` has an argument matching `/^@.*\/after-list-1280\.png$/` and `sizes` holds `PNG.length`.
  - `config.test.ts`: with `edited("seams.yml", ...)` setting the tensorx `images` to `[nope]`, `loadSeams` throws `seams.yml providers.tensorx.images: model nope is not in models`.
- [ ] **Step 2: Run** `pnpm vitest run factory/adapters/pi.test.ts factory/config.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the seam fields, the schema check and the Pi changes. Confirm on Pi 1.4.0 that `input` in `models.json` is the field that turns on image input (Pi's model config docs); fix the field name if not.
- [ ] **Step 4: Run** `pnpm vitest run && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Real model check (spec 10).** Add to the `real Pi harness` block of `harness.real.test.ts`: `test("the reviewer model reads an image")` sends a reviewer job on the `router.yml` low reviewer with one small solid red PNG (a base64 constant in the test) and the prompt `What is the main color of the image? Answer with one word.`; expect `ok` and text matching `/red/i`. Run `FACTORY_CONTRACT_REAL=1 pnpm vitest run factory/contracts/harness.real.test.ts -t image` with `TENSORX_API_KEY` set.
- [ ] **Step 6: Act on the result.** Pass: set `images: [z-ai/glm-5.3-flash]` on tensorx in `seams.yml`. Fail: list TensorX models (`GET https://api.tensorx.ai/v1/models`), pick one that reads images and whose family is not `deepseek`, add it to tensorx `models` (with its family) and `images`, put it in the `reviewer` of `router.yml` low and high, and run Step 5 again. If no TensorX model reads images: stop and ask the user (spec 10). Do not switch provider on your own.
- [ ] **Step 7: Run** `pnpm vitest run`. Expected: PASS (`loadRouter` accepts the families).
- [ ] **Step 8: Commit** `feat(harness): send screenshots to the Pi reviewer and list the models that read images`.

---

### Task 3: Code review judges each screen

**Files:**
- Modify: `factory/agents.ts:9` (`Finding`), `:74` (`reviewerPrompt`); `prompts/review.md`; `factory/seams.ts:57` (`Repo`); `factory/steps/repo.ts:100-106`; `factory/proof.ts`; `factory/steps/code-review.ts:11-15,33`; `factory/steps/test-helpers.ts:26-50,110-117`; every other `Repo` literal that typecheck names (`readBytes: () => undefined`)
- Test: `factory/proof.test.ts`, `factory/agents.test.ts`, `factory/steps/repo.test.ts`, `factory/steps/flow.test.ts`

**Interfaces:**
- Consumes: `Proof`, `readProof`, `PROOF_DIR` (Task 1); `Harness.images`, `Provider.images`, `HarnessJob.images` (Task 2).
- Produces in `factory/agents.ts`: `Finding { blocking: boolean; file?: string; text: string; screen?: string; verdict?: string }`; `reviewerPrompt(ticketText: string, diffText: string, proofText = "")` appends `\n\n<proof>\n${proofText}\n</proof>` only when `proofText` is not empty.
- Produces in `factory/seams.ts`: `Repo.readBytes(path: string, maxBytes: number): Buffer | undefined`. The real one returns `undefined`, never throws, for a missing file, a link, a path whose real path leaves the clone, or a file over `maxBytes`.
- Produces in `factory/proof.ts`:

```ts
export type Verdict = "matches" | "does_not_match" | "unsure";
export interface ScreenVerdict { screen?: string; verdict: Verdict; note: string } // no screen: about the proof as a whole
export interface ProofRecord { proof?: Proof; error?: string; verdicts: ScreenVerdict[]; readsImages: boolean; reviewer: string } // saved in code-review data as `proof`; reviewer is "<harness>/<model>"
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export function readImages(readBytes: Repo["readBytes"], proof: Proof | undefined): Record<string, Buffer>; // before/after names in manifest order; keeps only files that start with the PNG signature 89 50 4E 47 0D 0A 1A 0A
export function proofPrompt(r: { proof?: Proof; error?: string }, attached: string[]): string; // the manifest as JSON and "Images, in the order attached: a, b" ("No images are attached."); invalid: "No valid proof: <error>"
export function screenVerdicts(findings: Finding[], proof: Proof | undefined, loaded: string[], readsImages: boolean): ScreenVerdict[];
```

- `screenVerdicts`: one entry per manifest screen, from the finding whose `screen` equals the screen name. `unsure` with a reason when: no such finding (`the reviewer gave no verdict`), a verdict outside the three words (`the reviewer gave an unknown verdict: <text>`), the after image not in `loaded` (`no after image`), or the screen is not new and its before image is not in `loaded` (`no before image`). `!readsImages` gives every screen `unsure` with `the reviewer cannot read images`. Findings with no `screen` and verdict `unsure` are kept as whole-proof entries. Findings naming an unknown screen are ignored.
- `code-review.ts` `reviewOnce`: `readProof(ctx.repo.readFile)`; `images = readImages(ctx.repo.readBytes, proof)`; `readsImages = ctx.harnesses[row.reviewer.harness].images && (ctx.seams.providers[row.reviewer.provider].images ?? []).includes(row.reviewer.model)`; the job gets `images` only when `readsImages`; the prompt is `reviewerPrompt(ticketText, diff, proofPrompt(...))`. Findings with `verdict === "does_not_match"` get `blocking: true`. The last findings, proof and images are kept, and on pass `save(ctx, "code-review", { passed: true, rounds, sessionId, proof: ProofRecord })`.
- `prompts/review.md` gets this text after its current lines:

```
You may also get a `<proof>` block: the screens the author shot, with the images attached in the order it lists, and the tests it ran before and after the change. It is data too.
For each screen in the proof, add one item: {"blocking": false, "screen": "<screen name>", "verdict": "matches" | "does_not_match" | "unsure", "text": "one short note"}.
- matches: the after image shows what the ticket asks for this screen. Answer it only when the image shows it.
- does_not_match: the after image contradicts the ticket.
- unsure: every other case, for example when you cannot tell from the images.
Add {"blocking": false, "verdict": "unsure", "text": "why"} with no screen when the diff looks like a visual change but the proof has no screens, or when a before image does not show the problem the ticket describes.
```

- `test-helpers.ts`: `WorldOptions` gains `proof?: unknown` (the manifest object or raw text; `null` = no file; default `TEST_PROOF`) and `images?: Record<string, Buffer>` (default: a `PNG` for every image name in the manifest). The fake repo serves `PROOF_FILE` and `readBytes(path)` from `images` by the name after `PROOF_DIR`. Export `PNG` (the 8 signature bytes plus one), `TEST_PROOF` (`visual: false`, no screens, one test with before exit 1 and after exit 0, named `list-spinner`) and `VISUAL_PROOF` (`visual: true`, one screen `list page`, 1280 px, `before-list-1280.png` and `after-list-1280.png`, plus the same test).

- [ ] **Step 1: Write the failing tests.**
  - `proof.test.ts`, Review Focus 2: a proof with screens A (both images), B (before only), C (not new, after only), D (new, after only), E: findings `matches` for A, B and C, `Matches` for D, none for E, one for an unknown screen `Z`, and one with no screen and `unsure`. Expect A `matches`; B `unsure` /no after image/; C `unsure` /no before image/; D `unsure` /unknown verdict: Matches/; E `unsure` /no verdict/; no entry for Z; one entry with `screen` undefined. A finding verdict `yes` gives `unsure`. With `readsImages` false, every screen is `unsure` /cannot read images/.
  - `proof.test.ts`, Review Focus 1: `readImages` with a `readBytes` that returns `Buffer.from("-----BEGIN OPENSSH PRIVATE KEY-----")` for `after-list-1280.png` leaves that name out.
  - `repo.test.ts` on a real `gitRepo` temp clone, Review Focus 1: `run/proof/after-a.png` as a symlink to a PNG outside the clone gives `undefined`; `readBytes("../outside.png", MAX)` gives `undefined`; a plain 9-byte file gives the Buffer; the same file with `maxBytes` 4 gives `undefined`; a missing file gives `undefined`. None throw.
  - `agents.test.ts`: `reviewerPrompt("T", "D", "P")` contains `<proof>\nP\n</proof>`; `reviewerPrompt("T", "D")` contains no `<proof>`; `parseFindings('[{"blocking":false,"screen":"a","verdict":"matches","text":"ok"}]')[0].verdict` is `"matches"`.
  - `flow.test.ts`: "a does_not_match verdict blocks" (spec 12): `VISUAL_PROOF` world, a `factoryFile` with the preview keys, and three reviews each `[{ blocking: false, screen: "list page", verdict: "does_not_match", text: "no spinner" }]` ends `blocked` with a comment containing `Code review did not pass after 3 rounds` and `no spinner`. "the reviewer gets the screenshots": with one `matches` review, the reviewer job's `images.map((i) => i.name)` equals `["before-list-1280.png", "after-list-1280.png"]` and its prompt contains `<proof>`; `data(ctx, "code-review").proof.verdicts` equals `[{ screen: "list page", verdict: "matches", note: <the text> }]`. With `ctx.seams.providers.tensorx.images = []`, the reviewer job has no `images` and the saved verdict is `unsure`.
- [ ] **Step 2: Run** `pnpm vitest run factory/proof.test.ts factory/agents.test.ts factory/steps`. Expected: FAIL.
- [ ] **Step 3: Implement** the seam field, `readBytes` next to `readFile` (same `lstatSync` and `realpathSync` checks, `statSync(full).size > maxBytes` gives `undefined`), the proof functions, the review step, the prompt and the test helpers.
- [ ] **Step 4: Run** `pnpm vitest run && pnpm typecheck`. Expected: PASS, every existing flow test unchanged.
- [ ] **Step 5: Commit** `feat(review): judge each screen of the proof and block on does_not_match`.

---

### Task 4: Decision sends unproven changes to a person

**Files:**
- Modify: `factory/proof.ts`, `factory/steps/decision.ts:16-30` (`decideByChecks`)
- Test: `factory/proof.test.ts`, `factory/steps/flow.test.ts`

**Interfaces:**
- Consumes: `ProofRecord` from `data(ctx, "code-review")?.proof` (Task 3); `data(ctx, "prepare-patch").commands.preview` (Task 1).
- Produces: `proofReasons(r: ProofRecord | undefined, hasPreview: boolean): string[]` in `factory/proof.ts` (spec 6.4). Exact reasons, in this order:
  - no record or no valid proof: `no proof: <error, or "code review saved no proof">` (and nothing else);
  - `hasPreview && proof.visual && screens.length === 0`: `a visual change was expected but there are no screenshots: <note, or "no reason given">`;
  - screens exist and `!readsImages`: `the reviewer <reviewer> cannot read images, so no screen was judged` (then no per-screen lines);
  - each `unsure` verdict: `screen <name>: the reviewer is unsure: <note>`, or `the reviewer is unsure: <note>` with no screen;
  - `(!hasPreview || !proof.visual)` and no test with `before.exit !== 0 && after.exit === 0`: `no test failed before the change and passed after it`.
- `decideByChecks`: appends `proofReasons(...)` to the reasons of every `needs_approval` result (the Jev 2 error path, `decideMerge`, and the `mayAutoMerge` row reason). With no reasons at all it stays `auto`.

- [ ] **Step 1: Write the failing tests.**
  - `proof.test.ts`: one assertion per reason above, plus: `TEST_PROOF` with `hasPreview` false gives `[]`; `VISUAL_PROOF` with all `matches`, `readsImages` true and `hasPreview` true gives `[]`; `VISUAL_PROOF` with `hasPreview` false and its test passing before (`before.exit: 0`) gives the test reason.
  - `flow.test.ts`, spec 12, each through `runBuildPipeline`:
    - "an unsure verdict sends the change to a person": `VISUAL_PROOF`, preview keys, review `unsure` "cannot see the spinner" ends `needs_approval`, not merged, and the last change comment contains `screen list page: the reviewer is unsure: cannot see the spinner`.
    - "a visual change with no screens sends the change to a person": proof `{ visual: true, screens: [], tests: [], note: "the dev server did not start" }` with preview keys ends `needs_approval` (not `blocked`) with a reason containing `the dev server did not start`.
    - "a change with no visual part and a test that failed before and passed after merges on the existing rules": the default world (`TEST_PROOF`) triggers finish, as `trivial ticket: build pipeline ends in auto-merge with no person` does.
    - "the same change with no such test goes to a person": `TEST_PROOF` with `before.exit: 0` ends `needs_approval` with `no test failed before the change and passed after it`.
    - `proof: null` ends `needs_approval` with `no proof: no run/proof/proof.json`.
- [ ] **Step 2: Run** `pnpm vitest run factory/proof.test.ts factory/steps/flow.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `proofReasons` and the `decideByChecks` change.
- [ ] **Step 4: Run** `pnpm vitest run && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(decision): send a change without proof to a person`.

---

### Task 5: Proof section on the change

**Files:**
- Modify: `factory/seams.ts:62-73` (`CodeHost`), `factory/gitlab.ts` (after `call` at `:18-26`), `factory/adapters/gitlab-code-host.ts`, `factory/fakes.ts:80-157` (`fakeCodeHost`), `factory/contracts/codeHost.contract.ts`, `factory/proof.ts`, `factory/steps/precommit-gate.ts:12-15,40-46`, `factory/steps/decision.ts:16-30,36-39`, `factory/steps/test-helpers.ts` (`attachFails`)
- Test: `factory/proof.test.ts`, `factory/adapters/gitlab-code-host.test.ts`, `factory/steps/flow.test.ts`

**Interfaces:**
- Consumes: `ProofRecord`, `readProof`, `readImages` (Tasks 1, 3).
- Produces in `factory/seams.ts`: `CodeHost.attach(name: string, data: Buffer): Promise<string>`, which returns a link the change body can use in Markdown.
- Produces in `factory/gitlab.ts`: `uploadFile(projectId: number, name: string, data: Buffer): Promise<string>`: `POST /projects/:id/uploads` with a `FormData` whose `file` is `new Blob([data], { type: "image/png" })` named `name`; headers only `PRIVATE-TOKEN` (fetch sets the multipart type); returns the response's `url`; a non-ok status throws `GitLab POST /projects/<id>/uploads failed with status <n>` like `call`. The code host adapter's `attach` calls it with the cached project id.
- Produces in `factory/fakes.ts`: `fakeCodeHost` gains the option `attachFails?: number` (the first n `attach` calls throw `GitLab POST /projects/1/uploads failed with status 500`), `attachCalls: number` (every call, failed or not) and `attached: { name: string; size: number }[]` (uploads that worked); `attach` returns `/uploads/<n>/<name>` with `n` from 1. `WorldOptions` gains `attachFails` and passes it on.
- Produces in `factory/proof.ts`: `proofSection(r: ProofRecord | undefined, links: Record<string, string>, failed: string[] = []): string`. Mockup B2, in this shape:

```
## Proof

### Screen 1: list page, 1280 px: matches
| Before | After |
| --- | --- |
| ![before](/uploads/1/before-list-1280.png) | ![after](/uploads/2/after-list-1280.png) |

Reviewer: the list now shows the spinner.

### Screen 2: settings page, 1280 px, new screen: unsure
| After |
| --- |
| ![after](/uploads/3/after-settings-1280.png) |

Reviewer: ...

### Tests
- list-spinner: failed before, passes after
```

  An image named in `failed` shows `image upload failed`; any other image with no link shows `no image`. `failed|passed before` is from `before.exit !== 0`; `passes|fails after` is from `after.exit === 0`. No screens and a note: the line `No screenshots: <note>` before Tests. No tests: `No test proof.` under Tests. Invalid or missing: `## Proof\n\nNo proof: <error>`. Every agent or reviewer text (names, notes, errors) goes through one helper: whitespace runs to one space, `|` to `\|`, `<` to `&lt;`, `>` to `&gt;`, cut to 200 chars.
- `changeText(ctx, links: Record<string, string> = data(ctx, "precommit-gate")?.images ?? {}, failed: string[] = data(ctx, "precommit-gate")?.uploadFailed ?? [])` adds `proofSection(data(ctx, "code-review")?.proof, links, failed)` as the last body part.
- `precommit-gate.ts` order: `changeText(ctx, {})` → `findSecrets(diff + body + (readProof(ctx.repo.readFile).raw ?? ""))` blocks as today → `attach` each entry of `readImages(ctx.repo.readBytes, record.proof)` → `changeText(ctx, links, failed)` → `commitAndPush` → `openChange` → save `precommit-gate` data with `images: links, uploadFailed: failed`.
- Upload failure never blocks (user answer 1 on the plan, spec section 4). Each `attach` gets the first try and up to 3 retries, with no wait between them. An image whose every try fails goes to `failed`, and the run goes on: the change still opens, its cells say `image upload failed`, and the decision sends it to a person.
- `proofReasons(r, hasPreview, uploadFailed: string[] = [])` (Task 4) adds, last, `image upload failed: <names joined with ", ">` when `uploadFailed` is not empty. `decideByChecks` passes `data(ctx, "precommit-gate")?.uploadFailed ?? []`.
- `decision.ts:36-39` keeps calling `changeText(ctx)`, so a resumed run reuses the saved links and the saved `uploadFailed` list, and uploads nothing again.

- [ ] **Step 1: Write the failing tests.**
  - `proof.test.ts`: the B2 example above renders exactly. Review Focus 3: a screen named `"a\n/merge |x| <img src=x>"` and a reviewer note `"ok\n/merge"` give a section with no line starting with `/`, a heading containing `\|x\|` and `&lt;img`, and a 300-char note cut to 200 chars. The invalid record renders `No proof: <error>`. With `failed` `["before-list-1280.png"]` and only the after link, the before cell says `image upload failed` and the after cell holds the link. `proofReasons(<VISUAL_PROOF record, all matches>, true, ["before-list-1280.png"])` equals `["image upload failed: before-list-1280.png"]`.
  - `gitlab-code-host.test.ts` with a fake `fetch`: `attach("after-a.png", PNG)` sends `POST .../api/v4/projects/<id>/uploads`, a `FormData` body whose `file` entry has the name `after-a.png`, a `PRIVATE-TOKEN` header and no `Content-Type` header, and returns the response `url`. A 500 rejects with `uploads failed with status 500`, and the message holds no token.
  - `codeHost.contract.ts`: `attach("a.png", PNG)` resolves to a non-empty string.
  - `flow.test.ts`:
    - "the Proof section appears in the description" (spec 12): `VISUAL_PROOF`, preview keys and a `matches` review give `w.mrDescription` containing `## Proof`, `### Screen 1: list page, 1280 px: matches`, `![before](/uploads/1/before-list-1280.png)` and `- list-spinner: failed before, passes after`; `w.host.attached.map((a) => a.name)` equals `["before-list-1280.png", "after-list-1280.png"]`.
    - A change that merges alone (default world) has `## Proof` and the test line in its description (spec goal 6).
    - A proof whose test tail holds a secret-looking value blocks with `secret-looking value`, with `w.host.attached` empty and nothing pushed.
    - Review Focus 5: after a full build run, `save(w.ctx, "event", { ticket: "8", resumeAt: "decision" })` then `decision.run(w.ctx)` leaves `w.mrDescription` unchanged and `w.host.attached.length` unchanged.
    - "an image upload that keeps failing still opens the change and sends it to a person": `VISUAL_PROOF`, preview keys, a `matches` review and `attachFails: 99` end `needs_approval` (not `blocked`), with the change opened, `w.mrDescription` containing `image upload failed`, `w.host.attachCalls` equal to 8 (2 images, 4 tries each), and the last change comment containing `image upload failed: before-list-1280.png, after-list-1280.png`.
    - "an upload that works on its last retry adds no reason": the same world with `attachFails: 3` has both names in `w.host.attached`, no `image upload failed` in `w.mrDescription`, and triggers finish as the default world does.
    - After the keeps-failing run, a resume at `decision` leaves `w.host.attachCalls` unchanged and the description still says `image upload failed`.
- [ ] **Step 2: Run** `pnpm vitest run factory/proof.test.ts factory/adapters factory/contracts factory/steps`. Expected: FAIL.
- [ ] **Step 3: Implement** the seam, the GitLab method, the fake, `proofSection`, the upload retries, and the gate and decision changes.
- [ ] **Step 4: Run** `pnpm vitest run && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(change): upload the screenshots and add the Proof section to the change`.

---

### Task 6: Preview sandbox and browser in both places

**Files:**
- Modify: `factory/seams.ts:99` (`HarnessJob.preview`), `factory/steps/prepare-patch.ts:23`, `factory/steps/context.ts:149-153` (`fix`), `factory/adapters/pi.ts:27-40,77`, `factory/agents.ts:39-48` (`factorySettings`), `factory/adapters/claude-code.ts:23-30,72`, `factory/steps/words.test.ts:6`, `runner/Dockerfile`, `.gitlab-ci.yml` (every step script, around `:117`), `factory/ci.test.ts:13-20`, `local-run.sh:32-35`, `docs/setup.md` (section 3)
- Test: `factory/adapters/pi.test.ts`, `factory/adapters/claude-code.test.ts`, `factory/steps/words.test.ts`, `factory/ci.test.ts`, `factory/steps/flow.test.ts`

**Interfaces:**
- Produces: `HarnessJob.preview?: boolean` (the author may start the target's preview server on localhost). `prepare-patch` and `fix()` pass `preview: !!commands.preview` (`fix` reads `data(ctx, "prepare-patch")?.commands`).
- Produces: `piSandboxSettings(cwd: string, home: string, provider: Provider, preview = false)` sets `network.allowLocalBinding: true` when `preview` (the store case stays as is); `runAuthor` passes `job.preview`.
- Produces: `factorySettings(env, hooksDir, cwd, inboxFile?, preview = false)` sets `settings.sandbox.network.allowLocalBinding = true` when `preview`; the Claude Code adapter passes `job.preview`.
- Both `agentEnv` functions keep `PLAYWRIGHT_BROWSERS_PATH` when set.
- `TOOL_WORDS` gains `|playwright|chromium`.
- CI: every step script gets `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` right after `CLAUDE_CONFIG_DIR="$PWD/run/claude-home"`, as a fixed value and never `"$PLAYWRIGHT_BROWSERS_PATH"` (trigger callers can set any variable). `STEP_PREFIX` gains the same item in the same place.
- `runner/Dockerfile`: one `RUN` that installs Chromium with `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npx -y playwright@1.62.1 install --with-deps chromium` (the version of `playwright` in `react_frontend/apps/web/package.json`; the comment says to bump both together), checks it with `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npx -y playwright@1.62.1 screenshot about:blank /tmp/check.png`, makes `/ms-playwright` readable by all, and cleans the npm cache.
- `local-run.sh`: the `env -i` list gains `PLAYWRIGHT_BROWSERS_PATH="$HOME/Library/Caches/ms-playwright"`, plus a comment with the one-time install (`pnpm exec playwright install chromium` in `react_frontend/apps/web`).
- `docs/setup.md` section 3: the manual follow-up. After this merges to main, the `job-image` job prints the image digest. Put it in the `.factory` image of `.gitlab-ci.yml` and in `jobImage` of `targets/react_frontend.yml` in one reviewed change (`compose.ts:74` needs them equal). Until then CI has no Chromium, so every visual change in CI goes to a person.

- [ ] **Step 1: Write the failing tests.**
  - `pi.test.ts`: with `FACTORY_PNPM_STORE` unset, `piSandboxSettings(cwd, home, tensorx, true).network.allowLocalBinding` is `true` and with `false` it is `undefined`; `agentEnv({ ...env, PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright" }, tensorx, dir).PLAYWRIGHT_BROWSERS_PATH` is `"/ms-playwright"` (update the exact-keys test to allow it only when set).
  - `claude-code.test.ts`: `factorySettings(env, HOOKS_DIR, cwd, undefined, true).sandbox.network.allowLocalBinding` is `true` and falsy without the flag; `agentEnv` keeps `PLAYWRIGHT_BROWSERS_PATH`.
  - `words.test.ts`: `TOOL_WORDS.test("npx playwright screenshot")` and `TOOL_WORDS.test("chromium")` are true.
  - `ci.test.ts`: the existing prefix test with the new `STEP_PREFIX`; the existing `/usr/bin/env` run, started with `PLAYWRIGHT_BROWSERS_PATH=/evil` in the caller env, prints `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`.
  - `flow.test.ts`: with the preview keys, the prepare author job and a fix job have `preview: true`; with the default `.factory.yml` both have no `preview`.
- [ ] **Step 2: Run** `pnpm vitest run factory/adapters factory/steps factory/ci.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the code, the CI prefix, the Dockerfile, `local-run.sh` and the setup note.
- [ ] **Step 4: Run** `pnpm vitest run && pnpm typecheck`. Expected: PASS. If Docker is available, `docker build -f runner/Dockerfile .` must pass its check line; otherwise the `job-image` job on main proves it.
- [ ] **Step 5: Commit** `feat(sandbox): let the author run the preview server and reach Chromium in both places`.

---

### Task 7: Author prompts after a sandbox spike, then the local trial

**Files:**
- Modify: `prompts/prepare.md`, `prompts/fix.md`, `factory/steps/prepare-patch.ts:22`, `docs/setup.md` (`Local use`), `docs/how-it-works.md` (steps 3, 4, 5 and 7: one line each)
- Test: `factory/steps/flow.test.ts`

**Interfaces:**
- Consumes: `HarnessJob.preview`, `piSandboxSettings(..., preview)`, `factorySettings(..., preview)` (Task 6); the `proof.json` shape (Task 1).
- Produces: `previewLine(c: FactoryCommands): string` in `prepare-patch.ts`. With a preview: ``Preview: start the app with `<preview>`. It serves <previewUrl>.`` Without: `Preview: this repo has no preview command. Take no screenshots; prove the change with tests only.` The first prompt becomes `${prompt("prepare")}\n\n${previewLine(commands)}\n\n${ticketText(ctx)}`. A resumed run still gets `CONTINUE`.

- [ ] **Step 1: Sandbox spike (manual).** In a `react_frontend` clone whose `.factory.yml` has the preview keys, run one command that starts the preview in the background, waits up to 120 s for `previewUrl`, runs `pnpm exec playwright screenshot --viewport-size "1280, 800" --wait-for-timeout 3000 <url> run/proof/after-x-1280.png` from `apps/web`, then stops the server:
  - (a) macOS: under `srt --settings` with `piSandboxSettings(clone, home, tensorx, true)` and `PLAYWRIGHT_BROWSERS_PATH` set;
  - (b) Linux: the same in a container of the `runner/Dockerfile` image (bubblewrap);
  - (c) Claude Code: the same as one Bash call under `factorySettings(..., true)`, if a Team plan token is at hand.
  Expected: a PNG that shows the app, not the "Opening your workspace" screen. Write the working command and the result per place in `docs/setup.md` under `Local use`. If (a) or (b) fails, stop and report the error to the user. Do not widen the sandbox beyond `allowLocalBinding` without asking.
- [ ] **Step 2: Write the failing test** in `flow.test.ts`: with the preview keys, the first author prompt contains ``Preview: start the app with `NEXT_PUBLIC_APP_ENV=development NEXT_PUBLIC_MOCK_ALL=true pnpm dev`. It serves http://localhost:3000.``; with the default `.factory.yml` it contains `Take no screenshots`.
- [ ] **Step 3: Run** `pnpm vitest run factory/steps/flow.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** `previewLine`. Add spec 6.1 rules 1-5 to `prompts/prepare.md`: decide `visual` from the ticket (if false, skip to rule 4); before any code change, shoot each screen the ticket names or the change touches, at most 5, at 1280 px and any width the ticket names, as `run/proof/before-<screen>-<width>.png` (lowercase letters, digits and dashes), starting the preview, waiting for its URL, shooting and stopping it in ONE shell command with the command proven in Step 1; after lint, test and build pass, shoot the same screens as `after-...`, and add a screen the change creates with `"isNew": true` and no before image; for each test written for the ticket, record the exit code and the last lines of output before the code change and after; write `run/proof/proof.json` in the Task 1 shape (give one example), and when a step fails, write why in `note` and go on with the ticket. Add to `prompts/fix.md`: when the change looks different, take the after shots again once lint, test and build pass, and update `proof.json`; when a fix changes a test, update its after exit code and output.
- [ ] **Step 5: Run** `pnpm vitest run && pnpm typecheck`. Expected: PASS.
- [ ] **Step 6: Local trial (manual).** Needs the preview keys in `react_frontend`'s `.factory.yml` on its default branch (a person adds them, spec 7). Run `./local-run.sh <iid>` on one visual ticket and one non-visual ticket. Expected: the visual change gets a Proof section with before and after images, a verdict per screen, and a decision that matches the verdicts; the non-visual change gets the Tests line and merges or waits only on the existing rules.
- [ ] **Step 7: Commit** `feat(prompts): tell the author how to take and record the proof`.
