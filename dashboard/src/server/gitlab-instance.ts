import { makeGitLab } from "./gitlab";
import { makeWorker } from "./worker";

let gitlab: ReturnType<typeof makeGitLab> | undefined;

// One instance, so the 15 s board cache is shared by every request.
export const getGitLab = () => (gitlab ??= makeGitLab());

// What runs the factory: GitLab CI, or the factory's own worker with FACTORY_CI=local (seams.yml ci: local).
export const getCi = () => (process.env.FACTORY_CI === "local" ? makeWorker() : getGitLab());
