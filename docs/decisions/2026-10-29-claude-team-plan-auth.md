# Claude Team plan token in the factory, and the Agent SDK

Date: 2026-10-29

## Question

A colleague said on Slack that using Claude plan tokens (Team, in our case) instead of an API key in a software factory is allowed "if you use the Agent SDK to talk to Claude Code". Is that right, and should the factory move to the Agent SDK?

## Decision

- No. The Agent SDK does not make plan tokens allowed. Anthropic's docs say the opposite: products built on the Agent SDK should use API keys unless Anthropic approved otherwise.
- Keep the factory as it is: unmodified `claude -p` in our GitLab CI with Kirill's `CLAUDE_CODE_OAUTH_TOKEN`. Moving to the SDK would be a rewrite with no legal benefit, because the SDK runs the same Claude Code binary.
- Send the Anthropic sales email in [go-live-emails.md](../go-live-emails.md) before go-live and keep the answer in writing. If the answer is no, replace `CLAUDE_CODE_OAUTH_TOKEN` with `ANTHROPIC_API_KEY`. Never set both, because the API key wins.

## Why

- Agent SDK overview: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in the Quickstart instead."
- Legal and compliance: "Developers building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider."
- In our favour: the Team plan falls under the Commercial Terms; OAuth "is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans"; the authentication docs present `claude setup-token` "for CI pipelines, scripts, or other environments where interactive browser login isn't available". The factory is internal use, not a product sold to others.
- Grey area: OAuth "is designed to support ordinary use of Claude Code". A factory that works for the whole team on one person's seat may count as seat sharing. No page says so either way. Anthropic "reserves the right to take measures to enforce these restrictions and may do so without prior notice", so the real risk is a block on Kirill's seat.

## Sources

- https://code.claude.com/docs/en/agent-sdk/overview
- https://code.claude.com/docs/en/legal-and-compliance
- https://code.claude.com/docs/en/authentication
