// The secret each adapter reads, by the name it has in CI. A leaf module: it imports nothing from the factory.
// An adapter with no secret (chat "console") has no entry.
export const ADAPTER_SECRETS: { tracker: Record<string, string>; codeHost: Record<string, string>; chat: Record<string, string> } = {
  tracker: { gitlab: "FACTORY_GITLAB_TOKEN", github: "FACTORY_GITHUB_TOKEN", "github-project": "FACTORY_GITHUB_TOKEN" },
  codeHost: { gitlab: "FACTORY_GITLAB_TOKEN", github: "FACTORY_GITHUB_TOKEN" },
  chat: { teams: "TEAMS_WEBHOOK_URL" },
};

// Secrets that arrive as File-type CI variables: every adapter secret once, then the dashboard token.
export const FILE_SECRETS: string[] = [...new Set([...Object.values(ADAPTER_SECRETS).flatMap((m) => Object.values(m)), "FACTORY_DASHBOARD_TOKEN"])];

// A secret the worker's own env holds under another name: deploy/compose.yml and install.sh name the GitLab token GL_TOKEN.
export const WORKER_ENV_NAMES: Record<string, string> = { FACTORY_GITLAB_TOKEN: "GL_TOKEN" };
