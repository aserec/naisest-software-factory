# Go-live checklist

One list for everything people must do before and during go-live on `react_frontend`. Do the sections in order. `docs/setup.md` has the detail for sections 1 to 3.

## 1. Accounts and GitLab

- [ ] Create the GitLab project `Ceresa/software-factory`.
- [ ] Create a bot user and a personal access token with the `api` scope.
- [ ] Make the bot Maintainer of the factory project. Set "Minimum role to use pipeline variables" to Maintainer.
- [ ] Store `FACTORY_GITLAB_TOKEN` as a masked, protected CI variable of type **File**.
- [ ] Signed in as the bot, create a trigger token. Store it as `FACTORY_TRIGGER_TOKEN`, type **File**.
- [ ] Check the license (Admin > License). Premium: give the bot merge rights by name on the protected branch of `react_frontend`. Free: make the bot Maintainer of `react_frontend`.
- [ ] Set `defaultApprover` in `targets/react_frontend.yml` to a real GitLab username.

## 2. Secrets

- [ ] `CLAUDE_CODE_OAUTH_TOKEN` from Kirill's `claude setup-token`. Put a one-year reminder in the team calendar.
- [ ] `TENSORX_API_KEY`.
- [ ] `TEAMS_WEBHOOK_URL`, type **File**, from a Teams Workflows flow "Post to a channel when a webhook request is received".
- [ ] `BERGET_API_KEY`, when it exists.
- [ ] Never set `ANTHROPIC_API_KEY` in the runner.

## 3. Runner and image

- [ ] Register the runner with tag `factory`. Copy `runner/config.toml.example` and `runner/cloud-init.yml` to the runner host. Fill in the tokens.
- [ ] Create the Hetzner firewall: no inbound rules, outbound internet only, no internal networks. Attach it.
- [ ] Push the repo. Check that the `smoke` job runs on a fresh VM and the VM is deleted after the job.
- [ ] Run `sync.sh` from agent-config to copy `.agents/`.
- [ ] Job image: install the `claude` and `opencode` CLIs at pinned versions in `/usr/local/bin`. Add `unzip`. Pin `node:22` by digest.
- [ ] Check that bubblewrap works in the job image for the sandbox. Check `enableWeakerNestedSandbox` and the `/proc` read deny against Node and pnpm.
- [ ] Check the image user, HOME, PATH and proxy settings with the `env -i` line in `.gitlab-ci.yml`.
- [ ] Check the runner's `<project>.tmp` secret directory layout, and the `TRIGGER_PAYLOAD` path.
- [ ] Check that the job artifact size limit is big enough, and that resumed runs use the same `CI_PROJECT_DIR`.
- [ ] Check the Hetzner plugin: the image tag `:1.4.7` format, the `token` and `user_data_file` keys, and that the SAST and secret detection jobs inherit the `factory` tag.
- [ ] Run `pnpm test` and `pnpm build` of `react_frontend` under the real sandbox. The `/proc` deny may break Node. Keep the image's user settings empty. Check that the reviewer's temporary HOME does not reinstall the provider package every run.
- [ ] Confirm the OpenCode tool names (`websearch`, `task`) and the openai-compatible provider config.
- [ ] Small config checks: the router `effortBump` limit, `loadTarget` name validation, and that the placeholder approver is replaced.

## 4. Written confirmations

- [ ] **Anthropic sales:** send a short description of the factory and ask if its use of the Team plan token (Kirill's seat) is allowed. Keep the answer in writing. If the answer is no, set `ANTHROPIC_API_KEY` instead.
- [ ] **TensorX:** get in writing where TensorX processes data and that its terms fit the GDPR and the sovereignty rule. Get the real `TENSORX_BASE_URL` and put it in the code (replace the placeholder). Replace the placeholder reviewer IDs `tensorx-deepseek-small` and `tensorx-deepseek-large` in `router.yml`.

## 5. Add react_frontend

- [ ] Merge `.factory.yml` into `react_frontend`: copy `docs/targets/react_frontend.factory.yml` in a reviewed merge request. Check `pnpm test` runs only what you want. If `react_frontend` gets a unit-only test script, switch to it.
- [ ] Follow `docs/add-a-repo.md`: work items on, webhook, bot access, one poll and one retry schedule.
- [ ] Add `factory_ready` to a test work item. Expected: the `event` job runs. Save the real webhook payload as a fixture and fix any parse error (the current fixtures come from GitLab's docs). If label events do not trigger, keep the webhook off and rely on the 5-minute poller.

## 6. Jev shadow test

- [ ] When `BERGET_API_KEY` exists, run on 30 closed work items:
  ```bash
  BERGET_API_KEY=... FACTORY_GITLAB_TOKEN=... pnpm tsx factory/steps/jev-shadow.ts react_frontend 30
  ```
  It writes `run/jev-shadow.csv`. It refuses to run without the real key.
- [ ] Check the answers by hand with the team.
- [ ] Set the thresholds in code (`factory/triage.ts` and the risk check) from the result. Commit the change with the CSV summary in the message.

## 7. Acceptance runs

- [ ] **Run 1:** label a trivial ticket in `react_frontend`. Expected: merged with a green main pipeline, `factory_done`, a result comment, no person involved.
- [ ] **Run 2:** label a medium-risk ticket. Expected: `factory_needs_approval`, reasons on the merge request, one Teams card.
