# Phase 1 build: rulings and parked findings

Decisions the build controller made on the team's behalf while running the phase 1 plan, in order, each with what it costs if wrong. Rework anything you disagree with.

## Rulings

- ## Rulings
- Ruling: T1 steps 1, 2 and 5 become checkboxes in docs/setup.md for people; the implementer does steps 3, 4 and 6 — they need accounts the session lacks — cost if wrong: none, they are still listed.
- Ruling: the factory repo path is Ceresa/software-factory, used everywhere the plan says acme/software-factory — the user created it there — cost if wrong: a rename later.
- Ruling: keep the existing SAST and secret detection includes in .gitlab-ci.yml and add factory jobs beside them — they were configured on purpose — cost if wrong: two extra jobs per pipeline.
- Ruling: T4 fixtures are built from GitLab's documented issue event payload; the real capture moves to T14 step 3 — no GitLab access here — cost if wrong: parse fixes at go-live.
- Ruling: T9 stream fixtures are written from the Claude Code docs, not by running claude; T9 step 6 (sandbox on a factory VM) moves to T14 go-live — no VM yet and no spend on Kirill's plan — cost if wrong: settings tweak at go-live.
- Ruling: router.yml reviewer IDs are placeholders `tensorx-deepseek-small` / `tensorx-deepseek-large` with a comment, confirmed at go-live in T14 — no console access — cost if wrong: one config edit.
- Ruling: T5 may set T3's mock answers so an empty description gets low clarity — the plan's T5 test requires it — cost if wrong: none.
- Ruling: score questions add optional `min` (default 2); the client returns value = min + level index, so a question with levels 9 answers on the spec scale 2–10; level labels sent to the API say "Score N" with the real number; the mock default score is 7 — the spec defines every score as 2–10 and thresholds depend on it — cost if wrong: one mapping change in jev.ts.
- Ruling: an active run is any of factory_running, factory_waiting, factory_paused, factory_needs_approval. Re-adding factory_ready on needs_info, blocked or done starts a new run, as spec 6.2 and section 7 require — cost if wrong: a duplicate run on a re-label.
- Ruling: duplicate events are stopped by the caller (Task 12): the event job uses resource_group factory-<project>-<iid>, reads live labels from GitLab after taking it, and sets factory_running before ending; decideStart documents this contract in a comment — cost if wrong: rare duplicate runs.
- Ruling (carry to Task 12): apply merges only after the MR pipeline reports "success"; the risk check and apply read the MR pipeline with a new GitLab method mergeRequestPipelineStatus(projectId, mrIid) using GET /projects/:id/merge_requests/:iid/pipelines, because branch-ref queries miss merge request pipelines; "canceled" counts as failed there — cost if wrong: a merge before green CI.
- Ruling (carry to Task 12): if parseNumstat throws, the risk check treats it as a failed hard rule and sends the change to a person — cost if wrong: none.
- Ruling (carry to Task 12): when askTriage or askRisk throws (Jev down or bad answer), the run does not guess: triage throws label factory_blocked with the error, risk-check throws send the change to needs_approval with the error as the reason — cost if wrong: a few extra human checks.
- Ruling (T9 C2, plan-mandated "allow Read"): narrow file tools to the working tree — allow Read/Edit/Write only for ./**, deny Read of //proc/**, the HOME and CLAUDE_CONFIG_DIR paths, and deny Edit/Write of ./.claude/** and ./.agents/**; add sandbox filesystem denies for /proc — the parent process holds GitLab and Teams secrets — cost if wrong: an agent that cannot read a file outside the repo it needs.
- Ruling (T9 C1): settings file and hook load from fixed absolute paths in the factory checkout or image, never from the agent cwd; target repo settings are not merged (setting sources limited) — cost if wrong: none.
- Ruling (T12, plan defect): the spec 6.7 approval path lands in Task 12. The event step also handles merge request events on factory branches: "approved" by a Developer+ who is not the bot starts the finish pipeline; a manual "merge" starts it with apply skipped. Only MRs whose source branch starts with factory/ count — cost if wrong: one more event type to maintain.
- Ruling (T12): .factory.yml gets a required `install` command (react_frontend: `pnpm install --frozen-lockfile`). Step code runs it inside the gate sandbox in every job that runs target code; artifacts exclude run/target/node_modules/** — cost if wrong: slower jobs.
- Ruling (T12 C1): gate and install commands run inside @anthropic-ai/sandbox-runtime with the same network allowlist and /proc read deny as the agent. FACTORY_GITLAB_TOKEN, TEAMS_WEBHOOK_URL and the trigger token are File-type CI variables: step code reads each file into memory and deletes it before any agent, install or gate command runs, so /proc environ holds only paths — cost if wrong: setup docs must say File type.
- Ruling (T12 C2): the factory never runs git in the agent's clone with credentials or config it does not control. Commits and pushes happen in a separate repo the factory creates, which fetches the clone's HEAD and pushes to an explicit URL; git diff and add in the clone run with -c core.fsmonitor= -c diff.external= --no-ext-diff --no-textconv — cost if wrong: none.
- Ruling (T12): apply merges only when the build record's decision was auto or the MR is approved by a person, and passes the reviewed head sha to the merge API — cost if wrong: none.
- Ruling (T12): a re-run force-pushes the factory-owned branch and reuses its open MR — cost if wrong: overwrites an earlier factory attempt, which is the intent of "run again".
- Ruling (T12 C2 amended): the factory keeps its own bare git dir (run/target.git) and uses the clone only as a work tree, so git never reads the clone's .git — meets the C2 goal better than the literal wording, which would run the clone's filter drivers — cost if wrong: none.
- Ruling (T12 trigger variables): phase 1 keeps trigger variables but trusts none of them for code paths: drop env overrides for BERGET_BASE_URL, TENSORX_BASE_URL and FACTORY_HOOKS_DIR (fixed in code or config); every CI job starts the step through `env -i` with an explicit allowlist (literal PATH, HOME, needed CI_* values, FACTORY_PIPELINE/TARGET/WORK_ITEM_IID/MR_IID/BUILD_PIPELINE_ID/SKIP_APPLY, the File-type secret paths); step code validates each FACTORY_* value by pattern; docs state the residual risk that anyone who sees a webhook URL can start factory pipelines and influence the job shell (BASH_ENV), so webhook settings stay Maintainer-only and the factory project sets the minimum role for pipeline variables to Maintainer — cost if wrong: an insider with Maintainer access to a target repo could reach the factory secrets.
- Ruling (T14 go-live.md:41): the reviewer flagged "set ANTHROPIC_API_KEY instead" as contradicting the constraint; spec 5 says exactly that when Anthropic says no. The constraint only means never set both. Keep the instruction, reword it to "replace CLAUDE_CODE_OAUTH_TOKEN with ANTHROPIC_API_KEY; never set both" — cost if wrong: none.

## Parked findings (accepted for now)

- Task 1: minor (deferred): typecheck not run in CI
- Task 1: minor (deferred): confirm plugin tag :1.4.7 format, token/user_data_file keys and that template analyzer jobs inherit the factory tag in a real pipeline (go-live)
- Task 2: minor (deferred): effortBump unbounded; loadTarget name not validated; placeholder approver loads silently (go-live check)
- Task 3: minor (deferred): Number(best) gives NaN on a non-numeric probability key; noul confidence = probability (API gives none)
- Task 4: minor (deferred): fixtures built from docs, real capture at go-live; no test pins runningInRepo excluding this item; payload parsed as any
- Task 5: minor (deferred, FINAL REVIEW MUST FIX): an unknown risk value with low confidence becomes "trivial" (indexOf -1) — lowers risk; should throw or treat as high
- Task 5: minor (deferred): no test pins injection-before-clarity order; boundaries clarity 6, risk conf 0.7 untested
- Task 6: minor (deferred): 404 detected by error text; short test token; assignMergeRequest untested; sha/label not URL-encoded
- Task 8: minor (deferred): out-of-range values give two reasons each
- Task 9: minor (deferred): sandboxed shell can still read HOME paths (file-tool denies only)
- Task 10: minor (deferred): blocked open list drops file locations; no throw test; fake returns [] after reviews run out
- Task 11: minor (deferred): TextBlock markdown makes ticket links clickable; loadRecord does not validate shape
- Task 12: minor (deferred): reused MR may keep approvals from an earlier head; nested node_modules not excluded from artifacts; npm registry allowed as egress
- Parked: noSkipCi single pass (fails closed); Premium merged-results sha (go-live check); closing keywords in untrusted text; noul probability not range-checked; secret scan misses binary/encoded secrets
