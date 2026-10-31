# Go-live emails

Two written confirmations are needed before go-live (see [go-live.md](go-live.md)). Edit the name, then send. Keep each answer in writing.

## Anthropic

Send through https://www.anthropic.com/contact-sales

```text
Subject: Using a Claude Team plan token in our own CI

Hello,

We are a team of four on a Claude Team plan. We built an internal tool that
runs the unmodified Claude Code CLI (claude -p) in our own GitLab CI to work
on tickets in our own repositories. It authenticates with a token one team
member created with `claude setup-token` (CLAUDE_CODE_OAUTH_TOKEN). It runs
at most 2 jobs at a time per repository, only for our own team, and is not
offered to anyone else.

Is this use allowed under our Team plan and the Commercial Terms, or should
we use an API key from the Claude Console instead?

Thank you,
<name>, Acme
```

If the answer is no, replace `CLAUDE_CODE_OAUTH_TOKEN` with `ANTHROPIC_API_KEY`. Never set both.

## TensorX

```text
Subject: Data location and API details for code review use

Hello,

We use our TensorX subscription to run DeepSeek models for automated code
review. Before we start, please confirm in writing:

1. In which countries and data centers our prompts and outputs are processed.
2. That you do not train on our data, and how long you keep prompts and outputs.
3. That you sign a GDPR data processing agreement (please send it).
4. The exact OpenAI-compatible API base URL and the current DeepSeek model IDs.

Thank you,
<name>, Acme
```

Put the base URL in `factory/agents.ts` (`TENSORX_BASE_URL`) and the model IDs in `router.yml`.
