# The dashboard may cancel a factory pipeline

Date: 2026-10-29

## Decision

Factory scripts make every write to GitLab, with one exception: the dashboard may cancel a run's CI pipeline.

A stop works in two stages. The dashboard first records a stop request. The running step checks for it between tool calls, ends the author process, and the factory script sets `factory_stopped` and posts a comment. If the step has not stopped after 60 seconds, the dashboard cancels the pipeline through the GitLab API.

## Why

A step that is hung never reads the stop request, and it would run until its CI timeout of up to two hours. That hung step is the case where a person needs the stop most. Only a GitLab pipeline cancel can end a job from outside the job.

## Considered options

- Stop requests only, with no GitLab write from the dashboard. This was rejected because a hung job ignores the stop request.
- Full GitLab write access for the dashboard, covering labels, comments and merges. This was rejected because the factory scripts would then no longer be the only place that changes a work item.
