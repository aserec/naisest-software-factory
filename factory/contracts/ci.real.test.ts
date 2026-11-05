import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe } from "vitest";
import { makeGitLabCi } from "../adapters/gitlab-ci";
import { GitLab, GITLAB_URL } from "../gitlab";
import { ciContract } from "./ci.contract";

// Manual job only (contract-real in .gitlab-ci.yml): it talks to a real GitLab test project.
// The test project needs one pipeline that no trigger started (docs/setup.md section 9).
describe.skipIf(!process.env.FACTORY_CONTRACT_REAL)("real GitLab CI runner", () => {
  ciContract(async () => {
    const token = process.env.CONTRACT_GITLAB_TOKEN!;
    const gitlab = new GitLab(GITLAB_URL, token);
    const { id } = await gitlab.getJson(`/projects/${encodeURIComponent(process.env.CONTRACT_GITLAB_PROJECT!)}`);
    const foreignRun = (await gitlab.getJson(`/projects/${id}/pipelines?per_page=1`))[0]?.id;
    if (!foreignRun) throw new Error("The contract test project has no pipeline");
    const dir = mkdtempSync(join(tmpdir(), "contract-secrets-"));
    writeFileSync(join(dir, "token"), token);
    const env = { PATH: process.env.PATH, CI_SERVER_URL: GITLAB_URL, CI_PROJECT_ID: String(id), FACTORY_PIPELINE: "build", FACTORY_TARGET: "contract", FACTORY_WORK_ITEM_IID: "8", FACTORY_GITLAB_TOKEN: join(dir, "token") };
    return { ci: makeGitLabCi(env, dir), ticket: "8", secret: "FACTORY_GITLAB_TOKEN", foreignRun: String(foreignRun) };
  });
});
