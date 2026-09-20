---
name: taskcal-implement
description: Implement or modify a Taskcal product slice while preserving its staffing, consent, CSV authority, state, security, cost and recovery contracts. Use for application code, migrations, APIs, workers, UI flows and tests; do not use for a documentation-only decision review.
---

# Implement a Taskcal slice

## Establish the contract

Read the part of `AGENTS.md` relevant to the task, then inspect the current code and only the governing documents:

- Domain behavior: `docs/rfc/RFC-009-domain-v04.md`
- CSV authority: `docs/rfc/RFC-010-csv-authority.md`
- Outreach and consent: `docs/rfc/RFC-011-outreach-and-state.md`
- Acceptance and delivery: `docs/rfc/RFC-012-delivery-and-acceptance.md`
- Unresolved choices: `docs/OPEN-QUESTIONS.md`

Name the affected acceptance cases and open-question IDs before freezing behavior. If an unresolved choice blocks implementation and the user has not selected it, use the documented initial recommendation as a reversible MVP default. Record it as an assumption; do not claim it is an accepted product decision.

## Build the vertical slice

Keep the slice small enough to demonstrate from input through persisted outcome. Separate:

- domain rules and state transitions;
- application orchestration and transaction boundaries;
- CSV, OrcaRouter and messaging adapters;
- API and UI presentation.

Use deterministic code for authorization, identity, candidate eligibility, interval math, latest-consent selection, monthly limits, deadlines, budget and final adoption. Restrict model output to validated structured data and an allowlist of next actions.

For state changes, use stable operation IDs, request hashes and stored results. Persist incoming events before model work. Recheck versions, pending replies, stop state and consent immediately before formal adoption. Never replay an unknown external effect without result lookup or reconciliation.

## Verify the behavior

Add focused tests for the changed contract. Cover the happy path plus the relevant duplicate, stale, concurrent, stopped, partial or unknown-result case. Link tests to A01-A18 when applicable.

Keep deterministic tests separate from live OrcaRouter evaluation. For live calls, enforce a configured budget before calling and record measured, estimated and unavailable values distinctly.

Run the documented formatter, type-check and focused tests. Report exactly what ran and what remains unverified.

## Keep records aligned

Update setup instructions when commands or environment requirements change. If the implementation changes a durable decision or observable contract, invoke `taskcal-record-decision` and update the ADR/RFC before considering the slice complete.
