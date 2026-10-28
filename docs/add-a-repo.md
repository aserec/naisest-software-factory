# Add a repo

Do these steps for each new target repo. Replace `<name>` with the target name.

## 1. In the target repo

- [ ] Turn on work items (issues): Settings > General > Visibility, project features.
- [ ] Add the bot as a member. Use Maintainer if your GitLab is Free. On Premium, give the bot merge rights by name on the protected branch.
- [ ] Add `.factory.yml` at the repo root, in a merge request that a person reviews. Required keys: `install`, `lint`, `test`, `build`. Optional: `smoke`. See `docs/targets/react_frontend.factory.yml`.
  ```yaml
  install: pnpm install --frozen-lockfile
  lint: pnpm lint
  test: pnpm test
  build: pnpm build
  ```
- [ ] Add the webhook (Settings > Webhooks) for issue and merge request events only. Leave comment events off: no comment starts a run, and each event starts a pipeline. URL:
  ```text
  https://gitlab.example.com/api/v4/projects/<factory project id>/ref/main/trigger/pipeline?token=<trigger token>&variables[FACTORY_PIPELINE]=build&variables[FACTORY_TARGET]=<name>&variables[SAST_DISABLED]=true&variables[SECRET_DETECTION_DISABLED]=true
  ```
  - Every label change, also the factory's own, starts a pipeline. The `event` job stops at once when the event is not a person adding `factory_ready` (or a person approving or merging a factory MR), and the later jobs skip.
  - The trigger token must be the one the bot owns, stored in the factory project as the File-type variable `FACTORY_TRIGGER_TOKEN`.
  - Keep webhook settings Maintainer-only. Whoever sees the URL can start factory pipelines.
  - If label events do not start the `event` job, keep the webhook off and rely on the poller.

## 2. In this repo

- [ ] Add `targets/<name>.yml`. Copy `targets/react_frontend.yml`. Set `projectPath`, `defaultApprover` (a real GitLab username), `jobImage` (must be the image in `.gitlab-ci.yml`), `maxChangedLines`, `protectedPaths` and `dependencyFiles`.
- [ ] Open a merge request here. `<name>` must match the file name. Other names stop the job.

## 3. Schedules

Create two schedules for the target (Build > Pipeline schedules). Sign in as the bot, so the bot owns them. Target branch `main`.

- [ ] **Poll**: `*/5 * * * *`. Variables: `FACTORY_SCHEDULE=poll`, `FACTORY_TARGET=<name>`, `SAST_DISABLED=true`, `SECRET_DETECTION_DISABLED=true`.
- [ ] **Retry**: `0 * * * *`. Variables: `FACTORY_SCHEDULE=retry`, `FACTORY_TARGET=<name>`, `SAST_DISABLED=true`, `SECRET_DETECTION_DISABLED=true`.

## 4. Check

- [ ] Add `factory_ready` to a small test work item. The `event` job should run (from the webhook or within 5 minutes from the poller).
