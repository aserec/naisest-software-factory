// The GitHub API base, GITHUB_API_URL for GitHub Enterprise. Shared by the tracker and the sign-in.
export const githubApi = (): string => (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
