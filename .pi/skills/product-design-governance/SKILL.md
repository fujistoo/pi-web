---
name: product-design-governance
description: Govern an auditable Jira-to-design workflow with evidence, specialist challenge, durable decisions, and deterministic readiness gates. Use for product discovery, RBAC/scenario analysis, Figma feedback, PRD reconciliation, or Ready for Dev decisions.
---

# Product Design Governance

This is methodology, not a store of live product knowledge. Retrieve live Jira, Figma, staging, and code evidence for each feature.

## Workflow

**Parallelism rule:** independent evidence and specialist passes must start together in one assistant response or one parallel workflow fan-out. Do not serialize independent Jira, code, Figma, RBAC, UX, or QA work. Sequence only steps whose inputs depend on an earlier result; concurrent writers require isolated worktrees/workspaces.

**Run and broker:** Start a durable run before delegation. Give each specialist a task ID and pass the feature, run ID, specialist role, and task ID in the `Agent` call. Mark task attempts with `start_task`, persist every outcome with `complete_task` and `record_specialist_result`, and use `join_run` before synthesis. Specialist-to-specialist questions use only the injected broker tools (`specialist_ask`, `specialist_reply`, `specialist_send`, `specialist_resume`, and `specialist_acknowledge`); messages are persisted before delivery. Use `resume_run` after a process/session interruption and invalidate affected tasks after an accepted decision or fresh source baseline.

1. Identify the issue/feature key and call `product_state` with `init`.
2. Retrieve the current Jira story/PRD and capture a numbered requirements baseline in `requirements.yaml`, including source references, actors, scope, acceptance criteria, and ambiguities.
3. Inspect adjacent product behaviour, code, configuration, staging, and Figma. Record evidence before proposing UI.
4. Run the RBAC/scenario analysis using materially distinct equivalence classes; do not generate every mathematical combination.
5. Persist each specialist result with `product_state` using its structured contract before synthesizing the next phase. Link the result to its run/task and requirement baseline; mark it stale when the baseline or affected product rule changes.
6. Build the reuse map before design. Prefer existing Figma components, existing screens, current product behaviour, and approved conventions. A gap must be explicit before a new pattern is proposed.
7. Run the designer and QA challenger. Route disagreements through the orchestrator and persist meaningful exchanges with `record_deliberation`; use the durable broker for live questions, then inspect `read_discussion` before resolving one.
8. If evidence and specialist challenge cannot resolve a product rule, call `request_clarification`. Ask the PO/PM only the blocking decision, with evidence, options, recommendation, affected requirements/scenarios/designs, and work that can continue.
9. On the PO/PM answer, call `record_decision`, then update requirements, scenarios, design map, annotations, and changes. Re-run affected specialists; a clarification is not the end of the workflow.
10. Convert client/Figma feedback into a product rule and impact analysis across roles, states, modules, notifications, reports, exports, mobile, and APIs. Record it with `record_change` before changing one screen.
11. Call `readiness` at each gate. Never claim Ready for Dev when a blocking check fails.

## Evidence and escalation

Keep these separate:

- **Evidence**: observed source material with a path, URL, issue reference, or version.
- **Inference**: a reasoned interpretation that may still be challenged.
- **Recommendation**: the option the orchestrator proposes.
- **Decision**: an explicit accepted PO/PM or already-approved product rule.

Resolve uncertainty in this order: explicit PO/PM decision, approved client decision, current Jira requirements, existing Figma/product patterns, staging behaviour, prior recorded decisions, then specialist deliberation. If none determines the rule, escalate. Never silently convert a recommendation into policy.

## Specialist contract

Every specialist result should contain a status (`resolved`, `needs_deliberation`, or `blocked`), summary, findings, evidence, affected IDs, questions for other specialists, and any clarification request. Persist it with `product_state` under `specialist-results.yaml`. Specialists are ephemeral experts and do not own the canonical record. They must not expose hidden chain-of-thought; persist only product-relevant evidence, challenges, proposals, and resolutions.

## Durable record

The canonical record is `.product/features/<feature>/`:

- `state.yaml` — lifecycle, source pointers, specialist status, open clarifications, and readiness flags.
- `requirements.yaml` — normalized traceable requirements and actors.
- `scenarios.yaml` — materially distinct RBAC/state scenarios.
- `design-map.yaml` — reuse/extend/gap map and annotations.
- `clarifications.yaml` — open and resolved PO/PM questions.
- `specialist-results.yaml` — structured specialist findings and their status.
- `decisions.yaml` — accepted outcomes.
- `changes.yaml` — requirement/design/annotation changes caused by decisions.
- `deliberations/DISC-*.yaml` — meaningful specialist discussions.
- `feedback/`, `external-writes/`, and `verification/` — feedback provenance plus approval-gated external synchronization receipts and verification.
- `runs/RUN-*.yaml` — restartable task dependencies, attempts, participants, evidence freshness, and stale outcomes.

Use `product_state` rather than freeform chat for these records. Keep Jira as the requirement history, Figma as the visual history, and Git as the semantic relationship between them.

## Readiness gates

- `before_design`: requirements baseline, actors/scope, archaeology, reuse map, material scenarios, and no open clarification.
- `before_feedback`: the feedback rule and contradiction status are recorded, with no open clarification.
- `ready_for_dev`: feedback processed, material deltas annotated, PRD and Figma reconciled, RBAC/QA complete, contradictions resolved, and no open clarification.

If a gate fails, report the missing checks and what can proceed in parallel. Do not weaken a gate to make a status look complete.
