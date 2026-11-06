# The proof has an e2e video, and a test-only change needs no fail-before test

Date: 2026-11-06

## Decision

Two changes to the change proof (see [the change proof design](../superpowers/specs/2026-10-31-change-proof-design.md)).

**An e2e video.** When the target has a preview and the change is visual, the author records one e2e test with Playwright's video on, using `run/record.sh <test file[:line]> <name>`. The script writes `run/proof/<name>.webm` and up to 8 frames of it (`<name>-01.png` and on, cut with Playwright's own ffmpeg). The author sets `video` in `run/proof/proof.json`.

- The video goes to the change description as a link, never to a model (`readVideo`, max 20 MB, in `factory/proof.ts`).
- The reviewer gets the frames in time order, after the screens, and answers one verdict for the video under its file name (`prompts/review.md`). A model cannot watch a video, so frames are what it judges.
- A visual change with no video, with a preview, is a reason to send the change to a person, unless the proof note says why (`proofReasons`).

**Test-only changes.** The decision step normally asks for one test that failed before the change and passes after it. A diff that changes only test files (`testOnly` in `factory/rules.ts`, checked in the risk check) cannot have a test that fails before, because the old code is the same code. For such a change the proof needs every listed test to pass after it, and at least one test. Otherwise the proof has the reason `the change touches only tests, but no test passed after it`.

## Why

A screenshot shows one state. A person who reviews a click path wants to see it run. The reviewer can still check it, from the frames, so the video is not only decoration.

The fail-before rule made every test-only ticket, for example "add a test for X", go to a person for a reason that cannot be fixed. The exemption keeps the rule where it can hold.

## Considered options

- Send the video to a model. This was rejected because the models in use read images, not video.
- Let a person decide for each test-only change. This was rejected because the diff already says it is test-only, and the rule is a plain glob test.
- Count a path as a test by a target setting. This was not done yet. The globs are fixed (`**/*.{test,spec}.*`, `**/__tests__/**`, `**/tests/**`, `**/test/**`, `**/e2e/**`). Add a target list if a target names its tests differently.
