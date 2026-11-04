// The GitLab base URL, or undefined when GITLAB_URL is not set. Here and not in auth.ts, so the background loop does not load next-auth.
export const gitlabUrl = (): string | undefined => process.env.GITLAB_URL?.replace(/\/+$/, "") || undefined;
