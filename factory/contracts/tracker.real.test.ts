import { describe } from "vitest";
import { makeGitLabTracker } from "../adapters/gitlab-tracker";
import { GitLab } from "../gitlab";
import { GITLAB_URL } from "../gitlab";
import { trackerContract } from "./tracker.contract";

// Manual job only (contract-real in .gitlab-ci.yml): it talks to a real GitLab test project.
describe.skipIf(!process.env.FACTORY_CONTRACT_REAL)("real GitLab tracker", () => {
  trackerContract(async () => {
    const tracker = makeGitLabTracker(new GitLab(GITLAB_URL, process.env.CONTRACT_GITLAB_TOKEN!), process.env.CONTRACT_GITLAB_PROJECT!);
    const { ref } = await tracker.create({ title: `Contract run ${new Date().toISOString()}`, body: "Made by the tracker contract test. Safe to close.", marks: [], fingerprint: `run-${Date.now()}` });
    return { tracker, ref };
  });
});
