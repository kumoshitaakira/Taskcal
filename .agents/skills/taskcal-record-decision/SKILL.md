---
name: taskcal-record-decision
description: Create or update Taskcal ADRs and RFCs when a durable product, domain, architecture, security, cost or delivery decision changes. Use when resolving open questions or changing guarantees; do not use for routine code edits that preserve the current contract.
---

# Record a Taskcal decision

## Classify the change

Use an ADR for the choice, context, alternatives, consequences and replacement relationship. Use an RFC for the resulting behavior, data, interfaces, flows, failure handling and acceptance criteria. A meaningful decision often needs both.

Distinguish these states explicitly:

- user-confirmed decision;
- current documented design;
- proposed review improvement;
- reversible implementation assumption;
- unresolved question;
- implemented and verified behavior.

Do not turn one state into another without evidence. Preserve superseded documents as history and add links to the replacing record.

## Update the record set

When a decision affects an entry in `docs/OPEN-QUESTIONS.md`:

1. Record the selected value, date, reason and decision owner.
2. Add or update the ADR that explains the choice.
3. Update the governing RFC contract and affected Mermaid diagrams.
4. Fix the expected results in RFC-012 and any fixtures or tests.
5. Add the change and replacement relationship to `docs/CHANGELOG.md`.
6. Refresh `docs/README.md` and the root `README.md` only when navigation, setup or current status changed.

Keep terms consistent with RFC-009 through RFC-011. In particular, do not collapse `AbsenceCase`, `Outreach`, `ScheduleUpdate` and message delivery into one state, and do not call a prepared or exported CSV formally adopted.

## Make the record reviewable

State what changed, what stayed unresolved, what evidence exists and what must be tested. Use concrete examples for consent, concurrency or recovery rules. Avoid claims of implementation, production readiness, cost savings or legal compliance unless the cited evidence supports them.

Check links, numbering, status labels and old/new precedence before finishing.
