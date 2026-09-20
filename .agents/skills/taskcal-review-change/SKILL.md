---
name: taskcal-review-change
description: Review a Taskcal diff, design or implementation for domain correctness, consent safety, CSV adoption, idempotency, recovery, security, cost and four-day MVP fit. Use for PR, code, schema, API, UI and architecture reviews; do not edit unless the user separately requests fixes.
---

# Review a Taskcal change

## Scope the review

Inspect the requested diff or files and read only the governing sections of RFC-009 through RFC-012, related ADRs and `docs/OPEN-QUESTIONS.md`. Treat reference proposals and older RFCs as history when current records supersede them.

Trace each state-changing path from authenticated input through validation, persistence, external effect, result lookup, read-back and user-visible status.

## Review priorities

Look first for defects that could:

1. assign work without current, unambiguous consent;
2. expose or mix staff, store or tenant data;
3. adopt two plans, part of a plan or a stale plan;
4. lose or duplicate work after timeout, retry, restart or concurrency;
5. mistake prepared/exported CSV, unknown results or failed notifications for completion;
6. allow stale AI output to override a later reply, correction, withdrawal or stop;
7. bypass OrcaRouter, budget limits, model-output validation or server-side secret handling;
8. expand beyond the four-day MVP without protecting the core demonstration.

Then check API/schema compatibility, interval and timezone behavior, stable IDs, monthly-input completeness, accessibility of status UI, observability and test coverage. Map material gaps to D01-D12 or A01-A18 where possible.

## Report findings

Lead with findings ordered by severity. For each finding, give the exact file and line, the triggering scenario, the resulting behavior and the smallest safe correction. Separate confirmed defects from questions and assumptions.

If no actionable finding remains, say so and list residual risks, open decisions and checks that were not run. Do not infer that a design or test passed merely because a document describes it.
