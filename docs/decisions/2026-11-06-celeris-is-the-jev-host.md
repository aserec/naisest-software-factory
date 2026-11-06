# Celeris is the only Jev host

Date: 2026-11-06

## Decision

The judge that answers the factory's Jev questions (triage, duplicate check, risk, the injection check) is Celeris. `seams.yml` has `judge: jev-celeris`. The client (`makeJevClient` in `factory/jev.ts`) calls one fixed URL with the model `celeris-1.1-decision` and the key `CELERIS_API_KEY` (`JEV_HOST`). A step stops with an error when the key is not set. There is no silent stand-in.

The seam keeps two judges: `jev-celeris` and `model-call` (a chat model that answers the same questions, set by `judgeModel`). The `jev-berget` judge and `BERGET_API_KEY` are gone from code, `.gitlab-ci.yml` and `docs/setup.md`. The Jev shadow test (`factory/steps/jev-shadow.ts`) uses the same client.

## Why

Berget's Jev models were marked preview, and the code now has one fixed host. Celeris serves the same `/v1/systemone` API, so the questions and answers did not change. One fixed host also means one key to guard and one URL that no variable can change.

This replaces the choice in [the first design](../superpowers/specs/2026-10-28-software-factory-design.md) (Jev on Berget AI). It also removes the `judge: jev-berget` example in [the swappable modules design](../superpowers/specs/2026-10-29-swappable-modules-design.md).

## Considered options

- Keep Berget as a second host. This was rejected because a second host doubles the keys, the URLs and the tests.
- Call TypeSafe directly. This was rejected for the same GDPR reason as in the first design: it hosts Jev only in the US.
