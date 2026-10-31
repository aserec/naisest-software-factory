import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe } from "vitest";
import { makeGitLabCodeHost } from "../adapters/gitlab-code-host";
import { GITLAB_URL } from "../gitlab";
import { makeGitLabTracker } from "../adapters/gitlab-tracker";
import { GitLab } from "../gitlab";
import { codeHostContract } from "./codeHost.contract";

// Manual job only (contract-real in .gitlab-ci.yml): it talks to a real GitLab test project.
describe.skipIf(!process.env.FACTORY_CONTRACT_REAL)("real GitLab code host", () => {
  codeHostContract(async () => {
    const token = process.env.CONTRACT_GITLAB_TOKEN!;
    const path = process.env.CONTRACT_GITLAB_PROJECT!;
    const gitlab = new GitLab(GITLAB_URL, token);
    const host = makeGitLabCodeHost(gitlab, path, token, process.env, (await gitlab.getProject(path)).defaultBranch);
    const { ref: ticket } = await makeGitLabTracker(gitlab, path).create({ title: `Contract run ${new Date().toISOString()}`, body: "Made by the code host contract test. Safe to close.", marks: [], fingerprint: `run-${Date.now()}` });
    // A branch with one new file on top of the default branch.
    const dir = join(mkdtempSync(join(tmpdir(), "contract-clone-")), "target");
    const repo = host.cloneAt(dir);
    await repo.clone(await host.baseBranch());
    writeFileSync(join(dir, `contract-${Date.now()}.txt`), "Made by the code host contract test.\n");
    const branch = `factory/contract-${Date.now()}`;
    await repo.commitAndPush(branch, "Contract test commit");
    return { host, branch, ticket };
  });
});
