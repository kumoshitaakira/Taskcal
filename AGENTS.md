# Taskcal repository instructions

## Product and delivery context

Taskcal coordinates replacement staffing for a restaurant absence. The hackathon MVP is for one fictional store, one active case, one role and one required staffing slot. Two people have four days to build it. Treat this as a prototype with explicit limits, not evidence of production readiness.

Codex is the primary development agent. The main agent owns planning, edits, integration, validation and the final report. Custom agents are read-only reviewers unless their definition explicitly says otherwise.

## Sources of truth

Read only the documents needed for the current task, using this precedence:

1. The user's current request and decisions.
2. Accepted ADRs in `docs/adr/`.
3. Current RFCs, especially `RFC-009` through `RFC-012`.
4. `docs/OPEN-QUESTIONS.md` for choices that remain unresolved.
5. Older RFCs and `docs/references/` as history or evidence, not current requirements.

Start with:

- Domain and invariants: `docs/rfc/RFC-009-domain-v04.md`
- CSV authority and adoption: `docs/rfc/RFC-010-csv-authority.md`
- Outreach, consent and state: `docs/rfc/RFC-011-outreach-and-state.md`
- Delivery and acceptance: `docs/rfc/RFC-012-delivery-and-acceptance.md`
- Open decisions: `docs/OPEN-QUESTIONS.md`

Do not silently promote a review proposal, historical value or open question into an accepted decision. When implementation must proceed without a user-selected value, use the documented initial recommendation as a reversible MVP default and record it as an implementation assumption.

## Product boundaries

- Keep the MVP within fictional data and the simulated message inbox.
- Route real model inference through OrcaRouter from the server. Never expose gateway keys to a browser or mobile client.
- The model may interpret replies and propose a limited next action. Deterministic code must enforce identity, authorization, eligibility, time ranges, consent, limits, budget and state transitions.
- A reply is not consent unless the authenticated sender, referenced offer, date, time, role and intent are unambiguous and all deterministic checks pass.
- Never ask for an absence reason or require a reason for declining. Do not rank staff by prior declines.
- Do not describe CSV export as schedule completion. Completion requires the configured adoption, read-back and notification boundary.
- Preserve confirmed work when read-back or notification fails. Reconcile the unknown result instead of replaying blindly or reverting to an older schedule.

## Domain and state invariants

Treat `Schedule`, `AbsenceCase`, `Outreach` and `ScheduleUpdate` as separate state owners. Keep normal and replacement work in the same `ShiftAssignment` model.

Every state-changing operation needs a stable operation ID and request hash. The same ID with different content must fail; the same content must return or reconcile the saved result. Use stable assignment IDs that survive CSV row reordering. Never use a row number or display name as identity.

Before formal schedule adoption, recheck the case version, schedule/source revision, latest consent versions, pending replies, stop state, deadline, staff constraints and the completeness of monthly input. Adopt all assignments in a selected plan together. At most one plan may be formally adopted for a case.

Persist inbound events before processing them. Order replies by persisted receive order, not by model completion time. Late model output must not revive superseded consent. A stop prevents new outreach and adoption but does not erase already confirmed facts.

## Implementation workflow

1. Identify the RFC, ADR, open-question IDs and acceptance cases affected by the request.
2. Build the smallest end-to-end slice that produces reviewable behavior. Keep domain logic independent from UI, framework and gateway adapters.
3. Add deterministic checks before external effects. Persist enough state to recover after a process restart.
4. Validate the changed behavior with focused tests. Prefer acceptance IDs A01-A18 as test names or traceability metadata when applicable.
5. Update ADR/RFC/README material when behavior, guarantees, boundaries or setup instructions change.

Avoid adding Redis, Temporal, microservices, event sourcing, production messaging, multi-store support or generic administration unless a new accepted decision requires them.

## Quality and evidence

- Separate deterministic tests from live-model evaluation. A live model run does not replace invariant tests.
- Record the model, prompt/schema version, router decision source, token/cost values and whether each value is measured, estimated or unavailable.
- Treat timeouts and unknown external results as unknown. Do not record them as zero cost or definite failure.
- Never claim an acceptance case passed unless it was executed. Label designs, fixtures, targets and estimates accurately.
- Keep secrets, personal data, hidden reasoning and raw unnecessary messages out of logs and UI.

Once application code exists, keep the root `README.md` commands current. Run the repository's documented format, type-check and focused test commands before committing. If a command is unavailable, state that plainly rather than inventing success.

## Decision records

Use a new ADR when a durable choice changes architecture, authority, security, domain semantics or a previously accepted decision. Use an RFC for the implementable contract, flows, interfaces and acceptance criteria. Preserve old decisions as history; mark replacement relationships explicitly instead of rewriting the past.

When closing an open question, update its status, the relevant ADR/RFC, acceptance expectations and `docs/CHANGELOG.md` in the same change.

## Review agents

Use `taskcal-domain-reviewer` for changes to domain rules, state transitions, CSV adoption, consent, idempotency or concurrency. Use `taskcal-delivery-reviewer` for a final MVP, security, cost, UX and acceptance review. Delegate only bounded review work that can run independently; the main agent integrates findings and owns edits.

Review output should lead with actionable findings ordered by severity and cite exact files and lines. If there are no findings, state that and list residual risks or unexecuted checks.

## Repository hygiene

- Keep code identifiers and persisted enum values in English. Write product and design documentation in Japanese unless the user requests another language.
- Do not commit secrets, local environment files, generated dependency folders or real staff data.
- Keep commits focused. Do not rewrite unrelated user changes.
- Do not push, merge, deploy, publish or contact external people unless the user has authorized that action.
