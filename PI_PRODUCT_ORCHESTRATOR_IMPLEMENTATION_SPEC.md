# Pi Product Orchestrator — Implementation Specification

## Purpose

Implement a **single PO/PM-facing Product Orchestrator** inside Pi that manages the full product-design lifecycle from Jira PRD/user story through product discovery, RBAC/scenario analysis, Figma design, client feedback, clarification, PRD reconciliation, and design readiness.

The user must interact with **one agent only**.

The Product Orchestrator may delegate work to specialist subagents or tools, but those specialists are internal implementation details.

The system must preserve a durable, auditable product record so that important product decisions do not exist only inside chat history.

---

# 1. Success Criteria

The implementation is successful when the PO/PM can say:

> Review TK-XXXXX and take it through design analysis.

and Pi can:

1. retrieve the current Jira PRD/user story;
2. establish a requirements baseline;
3. identify relevant actors, roles, permissions, modules, states, and scope;
4. inspect existing product/Figma patterns before proposing new UI;
5. inspect staging/current implementation where available;
6. construct a reuse / extend / gap map;
7. construct materially distinct RBAC/scenario coverage;
8. allow specialists to challenge and clarify one another;
9. document all meaningful specialist deliberations;
10. escalate only genuine unresolved product decisions to the PO/PM;
11. provide a recommendation when requesting clarification;
12. persist the PO/PM decision;
13. propagate accepted decisions into:
   - requirements;
   - scenarios;
   - Figma/design;
   - annotations;
   - change log;
14. process later client/Figma feedback through impact analysis;
15. reconcile Jira PRD and Figma after material changes;
16. run a final QA/challenge pass;
17. prevent “Ready for Dev” while blocking gaps remain.

The system must remain resumable across Pi sessions.

---

# 2. Core Architecture

Use this conceptual architecture:

```text
                         PO / PM
                            |
                            v
                 PRODUCT ORCHESTRATOR
                 single user interface
                            |
           +----------------+----------------+
           |                |                |
           v                v                v
      PRD Analyst      Product Designer   Product Archaeologist
           ^                ^                ^
           |                |                |
           +----------> RBAC / Scenario <----+
                            |
                            v
                      QA Challenger
```

Important:

- The PO/PM talks only to the **Product Orchestrator**.
- Specialists may question, challenge, and respond to each other.
- Specialist-to-specialist communication should be routed through the Product Orchestrator / orchestration layer so it can be logged and controlled.
- Specialists should normally be **ephemeral executions**, not persistent autonomous agents.
- Durable product state must live outside conversation history.

---

# 3. Separation of Responsibilities

## 3.1 Product Orchestrator

The Product Orchestrator owns:

- overall workflow;
- current feature lifecycle phase;
- canonical feature state;
- delegation;
- specialist deliberation;
- clarification gate;
- decision recording;
- reconciliation;
- readiness gates;
- communication back to the PO/PM.

The Product Orchestrator is accountable for convergence.

It must not blindly trust the first specialist response.

It must allow specialists to challenge one another.

It must distinguish:

- evidence;
- inference;
- recommendation;
- unresolved product decision.

It must protect PO/PM attention by resolving questions from evidence and specialist discussion before escalating.

---

## 3.2 PRD Analyst

Primary question:

> What exactly is required?

Responsibilities:

- parse Jira PRD/user story;
- identify requirements and acceptance criteria;
- identify ambiguities, contradictions, missing cases;
- track requirement changes;
- determine PRD impact from design/client feedback;
- propose revised wording;
- identify whether a change is:
  - design clarification;
  - requirement clarification;
  - requirement change;
  - new requirement;
  - RBAC change;
  - implementation constraint.

Must not make final product policy decisions.

---

## 3.3 Product Designer / UX Specialist

Primary question:

> What is the best user experience while remaining consistent with the existing product?

Responsibilities:

- reason about UX;
- inspect and reuse existing Figma components/patterns;
- inspect comparable current-product behaviour;
- propose design changes;
- identify interaction implications;
- annotate all material deltas;
- challenge PRD requirements where the requested interaction conflicts with established product patterns;
- maintain design consistency.

Hard rule:

**Do not invent new visual language where existing product patterns can satisfy the requirement.**

Avoid introducing arbitrary:

- typography;
- spacing;
- colours;
- icons;
- components;
- interaction patterns;
- controls;
- status treatments;
- page structures.

Use priority:

1. existing Figma component/variant;
2. existing Figma screen/pattern;
3. equivalent staging/current-product implementation;
4. approved design-system convention;
5. only then classify as a design-system gap.

---

## 3.4 Product Archaeologist

Primary question:

> How does the actual product already solve this?

Responsibilities:

- inspect staging/current product;
- inspect existing Figma;
- inspect relevant code/configuration where useful;
- find adjacent workflows;
- identify existing UX conventions;
- identify current RBAC behaviour;
- identify implementation constraints;
- return evidence rather than opinions.

The Product Archaeologist is critical because product consistency is a non-negotiable requirement.

---

## 3.5 RBAC / Scenario Analyst

Primary question:

> For whom, under what conditions, does this behaviour apply?

Responsibilities:

Analyse relevant combinations of:

- role;
- permission;
- user type;
- module access;
- organisation/client;
- category scope;
- location scope;
- team scope;
- ownership;
- approval level;
- workflow state;
- feature access configuration;
- device/surface where relevant.

Do **not** generate every mathematical combination.

Collapse equivalent behaviours into materially distinct scenarios.

Explicitly distinguish:

- hidden;
- disabled;
- read-only;
- direct navigation blocked;
- action blocked;
- excluded from result set;
- filtered from selectable options;
- module entirely inaccessible.

---

## 3.6 QA Challenger

Primary question:

> What assumptions, states, permissions, or entry points have we missed?

Responsibilities:

Challenge:

- happy-path-only thinking;
- unhandled states;
- stale permissions;
- legacy records;
- cross-module effects;
- direct URL access;
- mobile behaviour;
- notification/report/export leakage;
- concurrency;
- approval transitions;
- archived/reopened scenarios;
- hidden vs disabled semantics;
- contradictory acceptance criteria.

The QA Challenger should ideally run after a proposed resolution/design exists.

---

# 4. Governance Skill

Create a project-local skill such as:

```text
.pi/skills/product-design-governance/
```

The skill should contain the reusable methodology, not project-specific volatile knowledge.

Suggested structure:

```text
.pi/skills/product-design-governance/
├── SKILL.md
└── references/
    ├── workflow.md
    ├── deliberation-protocol.md
    ├── rbac-analysis.md
    ├── scenario-analysis.md
    ├── figma-reuse.md
    ├── annotation-standard.md
    ├── clarification-gate.md
    ├── reconciliation.md
    └── readiness-gates.md
```

The skill governs:

- requirement baselining;
- product archaeology;
- reuse / extend / gap;
- RBAC analysis;
- scenario coverage;
- client-feedback interpretation;
- annotation rules;
- deliberation;
- clarification;
- PRD/design reconciliation;
- readiness.

Do not hardcode frequently changing product knowledge into the skill.

Live product knowledge should come from Jira, Figma, staging, code, and recorded feature decisions.

---

# 5. Product-Orchestrator Contract

Put always-on orchestration rules in the project's Pi startup instructions / agent instructions.

Conceptually:

```markdown
# Product Orchestrator

You are the sole PO/PM-facing product orchestration agent.

The user must never need to manually coordinate specialist agents.

Own the complete lifecycle:

Jira PRD
→ requirements analysis
→ product archaeology
→ RBAC/scenario analysis
→ UX/design
→ specialist deliberation
→ clarification
→ Figma iteration
→ client feedback
→ PRD reconciliation
→ readiness review.

Specialists may challenge one another.

Do not accept specialist conclusions solely because they were produced first.

Resolve uncertainty using, in order:

1. explicit PO/PM decisions;
2. approved client decisions;
3. current Jira requirements;
4. existing product/Figma patterns;
5. staging/current-product behaviour;
6. prior recorded decisions;
7. specialist deliberation.

If evidence cannot determine the product rule, invoke the Clarification Gate.

Protect PO/PM attention.

Do not escalate questions that can be answered through evidence or specialist deliberation.

Escalate genuine product decisions only, and always provide:
- why the question matters;
- known evidence;
- affected requirements/scenarios;
- available options;
- recommended option;
- whether work can continue elsewhere.
```

---

# 6. Durable Feature State

Do not use Pi conversation history as the product database.

Create a Git-versioned feature workspace:

```text
.product/
└── features/
    └── TK-XXXXX/
        ├── state.yaml
        ├── requirements.yaml
        ├── scenarios.yaml
        ├── design-map.yaml
        ├── decisions.yaml
        ├── changes.yaml
        └── deliberations/
            ├── DISC-001.yaml
            ├── DISC-002.yaml
            └── ...
```

The exact serialization can be YAML or JSON. Prefer human-readable, diff-friendly formats.

---

# 7. Canonical Feature State

Example:

```yaml
feature: TK-22015

lifecycle:
  phase: design_iteration
  iteration: 4

sources:
  jira:
    issue: TK-22015
    revision: 12
  figma:
    file: example
    version: 84

requirements_baseline: 3

open_clarifications:
  - CLAR-008

latest_decision: DEC-017

specialist_status:
  prd: complete
  archaeology: complete
  rbac: complete
  ux: blocked
  qa: pending
```

The orchestrator should reconstruct its working context from durable state at the beginning of each feature workflow.

---

# 8. Requirement Model

Represent product requirements in a normalized form.

Example:

```yaml
requirements:
  R1:
    source:
      type: jira
      reference: AC-3
    statement: "Authorised users can edit Area."
    status: active

  R2:
    source:
      type: client_feedback
      reference: FigmaComment-23
    statement: "Category Coordinators cannot edit Area after approval."
    status: active
```

Avoid relying only on freeform Jira prose once the workflow begins.

The canonical model should remain traceable back to source material.

---

# 9. Scenario Model

Example:

```yaml
scenarios:
  SC-001:
    role: TOA Admin
    permission: area_manage
    module_access: true
    state: Open
    expected: edit

  SC-002:
    role: Category Coordinator
    permission: area_manage_scoped
    module_access: true
    state: Approved
    expected: readonly

  SC-003:
    role: Location User
    module_access: true
    state: Open
    expected: readonly
```

Do not enumerate redundant combinations.

The RBAC specialist should produce equivalence classes where behaviour differs.

---

# 10. Reuse / Extend / Gap Map

Before design begins, require a map such as:

```yaml
reuse_map:
  location_selector:
    requirement: R1
    existing_pattern: "LocationMultiSelect"
    source: "Figma"
    action: reuse

  approval_modal:
    requirement: R3
    existing_pattern: "ApprovalModal"
    source: "Staging"
    action: reuse

  area_relationship:
    requirement: R4
    existing_pattern: null
    action: gap
```

Valid values:

- `reuse`
- `extend`
- `gap`

A `gap` must be explicitly surfaced before introducing a new product pattern.

---

# 11. Figma Annotation Standard

Every material design delta from the current product must be annotated.

A developer must **not** need to manually diff staging against Figma to understand what changed.

Use annotation categories such as:

- `CHANGE`
- `NEW`
- `REMOVE`
- `RBAC`
- `STATE`
- `CLIENT`
- `AC`
- `GAP`
- `DEV`

Every material annotation should communicate:

- current behaviour;
- new behaviour;
- reason/source;
- affected roles/permissions;
- affected states;
- implementation classification;
- related Jira requirement/AC where possible.

Example:

```text
RBAC / CHANGE — #04

Current:
All users with Work Request access can see Edit.

New:
Edit is available only to users with work_request.edit.

Category Coordinators without permission:
Read-only.

Users without Work Request module:
No access.

Source:
TK-XXXXX AC4 + Client feedback F23

Design:
Existing button component reused.
```

Also maintain a feature-level design change summary.

---

# 12. Deliberation Protocol

Specialists must be able to clarify and challenge one another.

However, do not implement uncontrolled direct recursive agent conversations.

Route specialist communication through the Product Orchestrator / orchestration layer.

Meaningful specialist exchanges must be persisted.

Use semantic message types:

- clarification;
- challenge;
- proposal;
- evidence;
- counterproposal;
- impact-analysis;
- approval-request;
- resolution.

Example deliberation record:

```yaml
id: DISC-018
feature: TK-22015

topic: "Category Coordinator Area editing"

raised_by: product-designer

messages:
  - from: product-designer
    type: clarification
    message: >
      Does AC4 grant editing of the complete Location form,
      or only fields already available under existing permissions?

  - from: rbac-analyst
    type: evidence
    message: >
      Existing RBAC restricts Area allocation to TOA.
    evidence:
      - staging:/locations/edit
      - permission:location.area.manage

  - from: prd-analyst
    type: challenge
    message: >
      AC4 wording is broader than the existing permission model
      and should not silently override it.

resolution:
  status: requires-product-decision
  recommendation: "Preserve existing RBAC and clarify AC4."
```

Persist **product-relevant deliberation**, not hidden chain-of-thought.

---

# 13. Specialist Output Contract

Subagents should return structured results rather than arbitrary essays.

Example:

```json
{
  "status": "needs_deliberation",
  "summary": "AC4 may unintentionally grant Area editing.",
  "findings": [],
  "questions_for_agents": [
    {
      "target": "rbac-analyst",
      "question": "Does current RBAC permit Category Coordinators to edit Area allocation?",
      "reason": "Required to interpret AC4"
    }
  ],
  "clarification_for_po": null
}
```

Resolved example:

```json
{
  "status": "resolved",
  "recommendation": "Preserve current Area restriction.",
  "basis": [
    "Existing RBAC",
    "Staging behaviour",
    "No explicit requirement overriding it"
  ],
  "prd_impacts": ["AC4 clarification"],
  "design_impacts": ["Area remains read-only"],
  "scenario_impacts": ["SC-008", "SC-009"]
}
```

The orchestration layer should validate these responses where practical.

---

# 14. Clarification Gate

Agents will encounter questions they cannot safely answer.

This must be a formal workflow.

```text
Specialist detects uncertainty
        |
        v
Can existing evidence resolve it?
        |
   +----+----+
   |         |
  yes        no
   |         |
 resolve     v
       Can specialists resolve it?
              |
         +----+----+
         |         |
        yes        no
         |         |
      document     v
              Clarification Request
                    |
                    v
                  PO/PM
                    |
                    v
             Decision recorded
                    |
                    v
        Re-run affected specialists
```

Questions should be classified:

### Blocking
Cannot safely continue the affected workflow.

### Partial blocker
Other work may continue, but a specific branch cannot be finalized.

### Non-blocking assumption
Strong precedent exists; proceed while recording the assumption for confirmation.

The orchestrator should batch related clarifications where practical.

---

# 15. Clarification Request Schema

Example:

```yaml
id: CLAR-012
feature: TK-22015

raised_by:
  - prd-analyst
  - rbac-analyst

severity: partial_blocker

question:
  "Can Category Coordinators edit Area while the request is Awaiting Approval?"

why_it_matters:
  - affects AC4
  - affects two Figma states
  - changes RBAC behaviour

evidence:
  jira:
    "AC4 says editing is allowed before approval."
  staging:
    "Current product allows editing while Awaiting Approval."
  client_feedback:
    "Feedback only explicitly mentions Approved."

options:
  A:
    behaviour: "Allow editing until Approved"
    impact: "Preserves current behaviour"
  B:
    behaviour: "Lock at Awaiting Approval"
    impact: "Introduces a new restriction"

recommended_option: A

blocked_work:
  - finalising RBAC matrix
  - finalising approved-state annotation

can_continue_elsewhere: true
```

Present this to the PO/PM in concise language.

Do not expose implementation noise.

---

# 16. PO/PM Decision Persistence

A PO/PM answer becomes an authoritative product decision.

Example:

```yaml
id: DEC-021
feature: TK-22015

source:
  type: po_clarification
  clarification: CLAR-012

decision:
  "Category Coordinators remain able to edit while Awaiting Approval
  and become read-only only once Approved."

affected:
  requirements:
    - AC4
  scenarios:
    - SC-012
    - SC-013
  designs:
    - FIG-005
    - FIG-007

follow_up:
  - update_prd
  - update_figma
  - update_annotations
  - rerun_rbac
  - rerun_qa
```

After a PO/PM decision, affected specialists must be re-run.

Do not treat the clarification itself as the final step.

---

# 17. Client Feedback Workflow

Client/Figma feedback must not be implemented as a narrow visual edit.

Convert feedback:

```text
Feedback
→ underlying product rule
→ affected dimensions
→ scenarios
→ design impact
→ PRD impact
→ annotations
→ QA challenge
```

Example:

Client says:

> Location Users should not see supplier pricing.

Do not only hide one field.

Analyse impact across:

- quote list;
- quote detail;
- Work Request detail;
- approvals;
- PDFs;
- emails;
- exports;
- reports;
- mobile;
- dashboards;
- API responses;
- derived totals.

The system should infer the **general rule**, then determine applicable surfaces.

---

# 18. Change / Decision / Deliberation Separation

Keep these concepts separate.

```text
DELIBERATION
Agents discuss ambiguity/options.

        ↓

DECISION
An outcome is accepted.

        ↓

CHANGE
The decision modifies requirements/design/state.
```

Example:

```text
DISC-018
"Should Category Coordinator editing include Area?"

DEC-009
"No. Preserve existing Area permission."

CHG-014
"Clarify AC4 and update Figma annotation #7."
```

This is essential for traceability.

---

# 19. Readiness Gates

Do not begin with an overly complex state machine.

Implement three initial gates.

## Gate 1 — Before Design

Require:

- PRD baseline captured;
- actors/roles identified;
- product archaeology completed;
- Figma/current-product patterns inspected;
- reuse map completed;
- material RBAC scenarios identified;
- blocking clarification absent.

## Gate 2 — Before Applying Material Feedback

Require:

- underlying product rule identified;
- affected requirements identified;
- affected scenarios identified;
- contradictions surfaced;
- blocking clarification absent.

## Gate 3 — Before Ready for Dev

Require:

- client feedback processed;
- all material deltas annotated;
- PRD reconciled;
- Figma reconciled;
- RBAC coverage complete;
- QA challenge complete;
- no blocking clarification;
- no unresolved contradiction;
- decision/change logs updated.

If the criteria fail, `Ready for Dev` must fail.

---

# 20. Recommended Project Layout

Adapt this to the actual Pi version and installed extension mechanism.

Do not assume undocumented Pi APIs.

Before coding, inspect the locally installed Pi documentation/examples and use the current supported extension/subagent APIs.

Conceptual layout:

```text
project/
├── AGENTS.md
├── .pi/
│   ├── agents/
│   │   ├── prd-analyst.md
│   │   ├── product-designer.md
│   │   ├── product-archaeologist.md
│   │   ├── rbac-analyst.md
│   │   └── qa-challenger.md
│   │
│   ├── skills/
│   │   └── product-design-governance/
│   │       ├── SKILL.md
│   │       └── references/
│   │
│   ├── prompts/
│   │   └── product.md
│   │
│   └── extensions/
│       ├── subagent/
│       └── product-orchestrator/
│           ├── index.ts
│           ├── feature-state.ts
│           ├── jira.ts
│           ├── figma.ts
│           └── staging.ts
│
└── .product/
    └── features/
```

If the installed Pi implementation uses different folder conventions, preserve the architecture and adapt only the physical layout.

---

# 21. Tool vs Agent Boundary

Use tools for deterministic operations.

Use agents for judgment/reasoning.

Recommended split:

| Capability | Type |
|---|---|
| Retrieve Jira issue | Tool |
| Retrieve Jira comments | Tool |
| Update Jira | Tool |
| Retrieve Figma comments | Tool |
| Inspect Figma components | Tool |
| Apply Figma updates | Tool |
| Inspect staging | Tool / browser |
| Persist feature state | Tool |
| Parse requirements | Agent |
| Infer underlying product rule | Agent |
| Determine best UX | Agent |
| Analyse RBAC scenarios | Agent |
| Challenge completeness | Agent |
| Reconcile product meaning | Agent + orchestrator |

Prefer domain-level tools such as:

```text
get_feature_context(TK-22015)
get_new_design_feedback(TK-22015)
record_decision(...)
run_readiness_check(...)
```

over exposing raw HTTP/API details to every agent.

---

# 22. Permissions / Authority Boundaries

Initially allow autonomous execution for:

- reading Jira;
- reading Figma;
- reading comments;
- inspecting staging;
- analysing requirements;
- analysing RBAC;
- finding existing patterns;
- creating local feature state;
- creating deliberation records;
- creating clarification requests;
- generating proposed design changes;
- generating proposed Jira deltas.

Require PO/PM approval for:

- new business rules;
- scope expansion;
- scope removal;
- breaking RBAC changes;
- granting a new role access;
- removing an existing role's access;
- introducing a new design-system pattern;
- destructive workflow behaviour;
- materially changing acceptance criteria where intent is not already explicitly approved.

Once the workflow is trusted, individual write actions may be relaxed.

---

# 23. Implementation Strategy

Implement incrementally.

Do not attempt Jira write-back, Figma mutation, browser automation, custom UI, and multi-agent orchestration simultaneously.

## Phase 1 — Orchestrator + State + Specialists

Implement:

- Product Orchestrator behaviour;
- product governance skill;
- five specialists;
- durable `.product/features/...` state;
- structured specialist output;
- deliberation logging;
- clarification logging.

Use fixture/sample PRD input if necessary.

### Verify

Given a sample feature, the system must:

- delegate appropriately;
- produce requirements;
- produce reuse analysis;
- produce scenario analysis;
- create deliberation when specialists disagree;
- escalate an unresolved decision;
- persist state.

---

## Phase 2 — Jira Read Integration

Implement Jira retrieval:

- issue;
- description;
- ACs;
- comments;
- links as needed.

### Verify

`Review TK-XXXXX`

must populate the canonical requirements baseline from live Jira.

No write-back yet.

---

## Phase 3 — Figma Read Integration

Implement:

- file/frame lookup;
- comments;
- component/pattern inspection where supported;
- current design context.

### Verify

The Product Designer and Product Archaeologist can cite/find existing patterns before proposing new UI.

---

## Phase 4 — Staging / Existing Product Inspection

Implement browser/product inspection.

### Verify

The Product Archaeologist can return evidence about current implementation and compare it to Figma/Jira.

---

## Phase 5 — Clarification UX

Start with plain chat output.

Later add Pi UI controls for:

- recommended option;
- alternative options;
- custom response.

### Verify

PO/PM decisions are persisted and affected specialists are automatically re-run.

---

## Phase 6 — Figma Write + Annotations

Only after read/reasoning flow is stable.

Implement:

- design modifications where supported;
- annotations;
- design change summary;
- mapping from requirement/scenario to frame/annotation.

### Verify

Material design changes are annotated and traceable.

---

## Phase 7 — Jira Write-back

Implement proposed-diff-first behaviour.

Preferred initial flow:

```text
detected PRD delta
→ proposed diff
→ PO/PM approval
→ Jira update
→ state refresh
```

### Verify

A requirement change is reflected in Jira and the local canonical state.

---

## Phase 8 — Ready-for-Dev Gate

Implement deterministic readiness validation.

### Verify

Ready-for-Dev fails if any required gate is incomplete.

---

# 24. Behavioural Examples

## Example A — New PRD

PO/PM:

> Review TK-22015 and prepare it for design.

Expected behaviour:

1. load Jira;
2. establish baseline;
3. run PRD Analyst;
4. run Product Archaeologist;
5. run RBAC Analyst;
6. allow cross-specialist questions;
7. run Product Designer;
8. run QA Challenger;
9. escalate unresolved product decisions;
10. persist all meaningful deliberation;
11. produce recommended design direction;
12. state outstanding blockers.

---

## Example B — Client Feedback

PO/PM:

> Process the latest client feedback.

Expected behaviour:

1. retrieve new feedback;
2. identify underlying product rule;
3. identify affected requirements;
4. identify affected RBAC/state scenarios;
5. consult Product Archaeologist for existing patterns;
6. allow specialists to challenge interpretation;
7. escalate only if still unresolved;
8. update local canonical state;
9. update design/annotations where authorised;
10. propose/update Jira delta;
11. run QA Challenger;
12. report what changed and why.

---

## Example C — PO Clarification

System asks:

> Client feedback says Category Coordinators cannot edit after approval.
> Current product allows editing while Awaiting Approval.
> Recommendation: preserve current behaviour.
>
> A. Editable until Approved
> B. Lock at Awaiting Approval
> C. Other

PO/PM:

> A

Expected behaviour:

1. persist decision;
2. close clarification;
3. update requirement model;
4. update affected scenarios;
5. re-run Product Designer;
6. re-run RBAC Analyst if needed;
7. re-run QA;
8. update change log;
9. resume the workflow automatically.

---

# 25. Version-Control Principle

Use Git for the auditable control layer.

Figma maintains visual/design history.

Jira maintains requirement history.

Git stores the semantic relationship between them.

Example:

```text
PRD Baseline 3
Design Iteration 5
Feedback Set 4
Scenario Matrix 5
Decision DEC-021
```

Do not attempt to replace Jira/Figma with Git.

Git is the durable reconciliation/audit layer.

---

# 26. Non-Goals for V1

Do not build:

- autonomous persistent specialist daemons;
- large agent swarms;
- exhaustive role × state combinatorial expansion;
- custom vector databases;
- a generic project-management platform;
- new design systems;
- automatic approval of material business-rule changes;
- unnecessary dashboards/UI before the core workflow works.

Keep V1 focused on correctness, auditability, and resumability.

---

# 27. Engineering Rules for the Implementing LLM

Before implementation:

1. inspect the installed Pi version;
2. inspect Pi's current local documentation/examples;
3. identify the supported subagent mechanism;
4. identify the supported skill loading mechanism;
5. identify the supported extension/tool registration API;
6. identify the supported startup-agent instruction mechanism;
7. do not assume API names from this document if the local Pi version differs.

State assumptions before making changes.

Prefer the smallest implementation that satisfies each phase.

Avoid speculative abstractions.

Do not refactor unrelated project code.

For each phase:

1. define the exact success criteria;
2. implement the minimum required code;
3. run a realistic test;
4. inspect the generated durable state;
5. fix issues before moving to the next phase.

---

# 28. First Build Target

The first working milestone should support this exact test:

> "Review TK-TEST-001 and take it through design analysis."

Using either a Jira fixture or live Jira read access, the implementation must:

- create `.product/features/TK-TEST-001/`;
- establish requirements;
- call at least:
  - PRD Analyst;
  - Product Archaeologist;
  - RBAC Analyst;
  - Product Designer;
  - QA Challenger;
- capture at least one inter-agent challenge/clarification;
- persist the deliberation;
- produce a clarification request if evidence is insufficient;
- record a PO/PM answer;
- update canonical state;
- re-run affected analysis;
- produce a final current-state summary.

Do not proceed to Figma/Jira mutation until this milestone is reliable.

---

# 29. Desired User Experience

The implementation must hide orchestration complexity from the PO/PM.

The user should be able to interact naturally:

```text
"Start design work for TK-22015."

"Process all new feedback."

"What's outstanding?"

"Go with option B."

"Prepare this for dev."

"Why did we decide this?"

"What changed since the previous design iteration?"
```

The Product Orchestrator must determine which specialists/tools are needed.

The PO/PM must never be required to manually invoke:

```text
/run-rbac-analysis
/run-prd-agent
/run-figma-agent
/run-qa-agent
```

unless such commands are provided strictly for debugging/development.

---

# 30. Final Architectural Principle

Implement:

> **One persistent Product Orchestrator + ephemeral specialist experts + durable Git-backed product memory + deterministic integration tools.**

The Product Orchestrator is the sole human-facing agent.

The governance skill defines how the team works.

Specialists provide independent expertise and challenge.

The orchestration layer records product-relevant discussions.

Jira, Figma, staging, and code provide evidence.

The PO/PM is asked only for decisions that genuinely require product judgement.

Every accepted decision must be traceable through:

```text
source
→ deliberation
→ clarification/decision
→ requirement impact
→ scenario impact
→ design impact
→ annotation
→ PRD reconciliation
→ readiness
```

That traceability is a hard requirement, not an optional enhancement.
