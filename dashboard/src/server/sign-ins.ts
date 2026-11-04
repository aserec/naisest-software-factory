// The one place that picks the sign-ins, like compose.ts picks the other adapters. Not in compose.ts:
// the background loop imports compose.ts and must not load next-auth, which the sign-in adapters use.
import { makeGitHubSignIn } from "./adapters/github-sign-in";
import { makeGitLabSignIn } from "./adapters/gitlab-sign-in";
import { gitlabUrl } from "./adapters/gitlab-url";
import type { SignIn } from "./seams";

// Each sign-in is on when its OAuth app is set (GitLab also needs GITLAB_URL): GitLab for GitLab targets, GitHub for GitHub targets.
export const signIns = (): SignIn[] => [
  ...(process.env.GITLAB_OAUTH_CLIENT_ID && gitlabUrl() ? [makeGitLabSignIn()] : []),
  ...(process.env.GITHUB_OAUTH_CLIENT_ID ? [makeGitHubSignIn()] : []),
];
