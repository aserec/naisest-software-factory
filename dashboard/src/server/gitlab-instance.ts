import { makeGitLab } from "./gitlab";

let gitlab: ReturnType<typeof makeGitLab> | undefined;

// One instance, so the 15 s board cache is shared by every request.
export const getGitLab = () => (gitlab ??= makeGitLab());
