# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Developers on target repos.** They labeled a work item `factory_ready` and want to know where its run is: which step, which round, what the logs say, and why it blocked or waits.
- **Team leads and managers.** They want to see what merged, what waits for a person to approve, and what each run cost.

## Product Purpose

The dashboard shows the software factory's work. The factory turns a labeled GitLab work item into a reviewed, checked and merged change in ten fixed steps. The dashboard lets a person follow each run, read why it stopped, and control the factory with switches. Success means a person can answer "where is my change and does it need me?" without opening GitLab CI.

## Positioning

- Scripts make every GitLab write. Agents only read code, edit code and run checks. The dashboard shows which script did what.
- Only low-risk changes with proof a person can trust merge without a person. Everything else waits for a person to press Merge.
- Each change carries proof: tests and before and after screenshots that the reviewer judges.

## Operating Context

- Runs live in GitLab work items, labels, merge requests and pipelines. The dashboard reads them; people still merge in GitLab.
- Sign-in is GitLab OAuth.
- Pages: the board of work items as cards, a run page with the step timeline and step logs, switches, the runner page (Grafana data, optional), and sign-in.
- Self-hosted behind HTTPS on the team's machine (`deploy/`).

## Capabilities and Constraints

- Next.js app in this workspace (`dashboard/`), Tailwind, Radix, lucide icons.
- Use the words in `GLOSSARY.md` at the repo root: work item, run, step, state label, run record, dispatch, author, reviewer, Jev, switch. Avoid the words it lists as "Avoid".
- Labels follow `docs/how-it-works.md`: one state label per work item, plus progress labels.

## Evidence on Hand

- `docs/how-it-works.md` and `GLOSSARY.md` describe the real process.
- Run records hold steps, models, rounds, cost and tokens.
- No customer quotes, case studies or metrics exist. Do not invent them.

## Product Principles

1. Show where a run is and whether it needs a person, before anything else.
2. Name the actor: which step, which script, which agent.
3. Show risk and proof plainly. Never make a change look safer than its risk check says.
4. Use the glossary words, the same word for the same thing everywhere.
