# Pi + Pixel Agents: implementation handoff

Prepared: 12 September 2026.
Status: implementation specification, not an implemented or tested integration.

## 1. Mission

Extend the existing Pixel Agents project and surface its office inside pi-web's `Agents` experience, so I can watch my real Pi coding agents working as animated characters. Keep using Pi normally in my terminal. The office is a read-only view of runtime activity, not a replacement agent framework.

My intended workflow has one PO/PM orchestrator delegating to specialists such as PRD, UX, research, Figma, engineering, and review. Support whichever of these agents actually exist. Do not create fictional team members or build the orchestration workflow as part of this integration.

The eventual experience should show actual delegation, agent-to-agent messages, blockers, and requests for my input. Conversations and decisions must be inspectable, not merely represented by decorative animation.

**Primary invariant: Pi owns execution; Pixel Agents visualizes evidence of execution. Turning off the office must not stop or change the agents.**

## 2. Defaults and boundaries

Use a local browser on the same machine as Pi, initially macOS. Reuse Pixel Agents' standalone server, existing browser transport, Canvas renderer, characters, pathfinding, and layout editor. Do not require VS Code, a cloud service, a new database, or an extra message broker.

The user-facing office belongs in pi-web's existing session-level `Agents` experience shown in the top toolbar and its dropdown/workspace (`AgentSessionPanel` / `AgentWorkspace`), rather than a separate top-level application. `Settings → Agents` (`AgentsConfig`) remains profile and runtime configuration. The Pixel Agents server/renderer is an implementation dependency behind that surface; Milestone 0 must verify whether it is embedded or reached through a same-origin adapter.

Keep pi-web's current design language authoritative: reuse its existing tokens, panels, typography, responsive behavior, accessibility patterns, and reduced-motion support. Taste Skill may be referenced for purposeful motion and anti-generic composition, but is not a runtime dependency, visual source of truth, or reason to copy a separate application shell.

Start with one Pixel Agents server operating in Pi mode. Preserve the existing Claude mode; simultaneous mixed-provider operation is not required. Keep approvals and replies in Pi for this version. Selecting an avatar may show details, but must not execute shell commands, launch agents, approve tools, or send prompts.

Do not replace models, authentication, skills, subagent packages, or agent definitions. Do not install packages globally, edit user-wide settings, publish a fork, or upgrade Pi without explicit approval. Prefer explicit loading of the new extension during development.

Build in the milestones below. Complete the working integration before adding spatial collaboration. When an existing orchestration capability is absent, expose that limitation and finish the independent milestones; do not invent an orchestration engine to fill the gap.

## 3. Source facts and compatibility checks

The upstream sources were inspected on the preparation date, but no specific commit was checked out or integration executed. Pin the actual revisions before coding; installed Pi types take precedence over examples copied from this document.

- Pixel Agents documents a standalone browser experience and a provider integration boundary. Its reference integration is Claude Code, not an already-working Pi provider. [S1]
- `core/src/provider.ts` declares `HookProvider` and normalized `AgentEvent` types. It also exposes tool-label and reading-animation classification. The relevant contract is here, not an assumed `core/providers/pi/` directory. [S2]
- The inspected standalone entry point still instantiates `claudeProvider` and references it in setup and scanning. Adding a provider file alone is therefore insufficient. [S3]
- The hook HTTP handler uses a provider-specific route but checks wrapper fields including `session_id` and `hook_event_name`. An HTTP success response alone does not prove an arbitrary Pi payload was processed. [S4]
- Pi's current extension documentation includes lifecycle, tool, settled-state, and blocking-UI-prompt notifications. Availability must be checked against the installed version. [S5]
- Pi's example subagent launcher uses separate processes with JSON output and `--no-session`; requiring a transcript file would exclude that case. [S6]
- Pixel Agents distinguishes named teammates from its ephemeral subagent representation. Preserve real Pi identity and make the UI mapping explicit rather than assuming those concepts are interchangeable. [S7, S8]

### Milestone 0 - establish the actual baseline

Inspect the target workspace, repository instructions, Git status, Pi executable/version, package identity, Node requirements, installed extensions, and the actual subagent launcher. Read Pixel Agents' contribution instructions and existing tests. [S9]

Use the existing Pixel Agents checkout when supplied; otherwise clone the canonical repository into a new directory. Work on a feature branch. Preserve unrelated changes; do not stash, reset, or overwrite them.

Write a brief compatibility record in `docs/pi-integration.md` containing:

1. Pixel Agents commit; installed Pi version/package; Node version; launcher name/version.
2. Verified event names and the exact files that instantiate/register providers, adopt agents, handle hooks, and serialize browser messages.
3. Baseline commands and results. Separate pre-existing failures from new failures.
4. The concrete source of child identity, parent identity, workflow messages, and human-input requests, or an explicit unsupported status.
5. The smallest implementation diff required for the milestones below.

**Gate:** the unmodified office runs locally, or a reproducible baseline blocker is recorded. Do not start unrelated refactoring.

## 4. Architecture

```text
Existing Pi terminal + existing child-agent processes
    |
    +-- Pi observation extension: runtime and tool activity
    |
    +-- Existing launcher/message adapter: parentage and workflow events
    |
    v
Non-blocking authenticated local HTTP delivery
    |
    v
Existing Pixel Agents standalone server
    |
    +-- Pi provider and narrowly scoped lifecycle integration
    +-- Existing agent state store
    +-- Read-only workflow metadata / activity history
    |
    v
Existing browser WebSocket transport
    |
    v
Existing animated office + selected-agent inspector
```

Use an observation extension for the interactive Pi process. For children, use either that extension or an adapter to the launcher's existing structured stream. Choose one telemetry owner per child; do not report the same child through both paths.

Do not force the normal interactive session into RPC mode. Do not read terminal pixels, scrape ANSI output, create fake Claude transcripts, or ask the LLM to narrate status for animation.

Pi's extension event bus may connect cooperating extensions within the same runtime; it is not a cross-process transport. Child processes still need explicit forwarding or their own observation extension.

### Proposed file placement

These are new-file suggestions, not claims about existing upstream paths:

```text
integrations/pi/index.ts             Pi observation extension
integrations/pi/transport.ts         Small transport helper, only if justified
server/src/<provider-location>/pi/   Beside the actual existing provider
<existing test locations>/           Provider, lifecycle and browser tests
fixtures/pi/                        Sanitized deterministic event fixtures
docs/pi-integration.md               Setup, compatibility and limitations
```

Use the actual repository conventions. Reuse shared contracts only where two layers need them. Do not introduce a new monorepo or a generic plugin framework.

The browser-facing office must be reachable from the existing pi-web `Agents` top-toolbar panel shown in the screenshot. Do not make the standalone Pixel Agents browser a second user-facing destination. Whether the office initially replaces or augments the current subagent chat workspace is an implementation/UI detail to settle after the current surface and renderer boundary are inspected; the destination itself is fixed.

## 5. Identity and event contract

Use a small versioned telemetry envelope. This is a proposed integration contract, not Pi's native event schema:

```typescript
type PiVisualEnvelope = {
  version: 1;
  producerId: string;       // unique telemetry producer epoch
  seq: number;             // monotonic within that producer
  agentId: string;         // unique live agent instance, never just a role
  piSessionId?: string;    // native session identity when available
  workflowRunId?: string;  // supplied by the actual orchestrator
  parentAgentId?: string;  // supplied by the actual launcher
  kind: string;           // validated against the supported event union
  timestamp: string;      // display time, not global ordering authority
  data: unknown;          // validate with kind-specific schemas
};
```

Define only the event variants required by the implemented milestones. Use `(producerId, seq)` as the event ID. Preserve tool-call IDs, message IDs, and request IDs from their actual sources. Adapt this envelope to the verified hook wrapper at the transport boundary; shared wrapper field names do not require pretending Pi events are Claude events.

Keep these distinctions:

- Role/display name is not identity. Two reviewers must remain two characters.
- A saved Pi session and a currently running process are different things. Reopening a session must not resurrect a dead process or merge simultaneous processes.
- Parentage must come from the launcher, not matching names, directories, timestamps, or prompt text.
- A tool returning, an agent run settling, a delegated task completing, and a process exiting are separate events.

On extension reload or process restart, create a new producer epoch and explicitly reconcile the previous observer. On session replacement, detach the old session and attach the new one according to the installed Pi lifecycle. Do not let an old shutdown event remove the replacement character.

## 6. Milestone 1 - one real Pi agent in the office

Implement the observation extension and Pi provider. Wire Pi mode into the actual standalone startup path. If a provider-selection option does not exist, add the smallest explicit selector and keep the current default behavior unchanged.

Reuse `HookProvider` where its contract fits. Installation status and consent must be truthful: loading an extension manually is not the same as having installed it globally. Do not implement methods that silently claim installation succeeded. Hide or explain unsupported install/launch controls in Pi mode.

Audit provider assumptions along the full path: startup, hook routing, session adoption, workspace scope, status formatting, cleanup, and browser initialization. Patch only assumptions that prevent this integration. No synthetic files or fabricated session events to satisfy Claude-specific scanning.

Do not assume the existing normalized event union already supports run-start, snapshots, heartbeats, explicit prompt resolution, or workflow metadata. Add only the lifecycle contracts needed by each milestone; do not fake a tool call to make the character active. Follow upstream protocol versioning, and update the source protocol specification plus generated browser types together when wire messages change. [S2, S9]

The existing server registry must not silently connect a Pi client to a Claude-only server. Check provider compatibility as well as standalone/embedded compatibility. Restrict adoption to the selected workspace; explicitly linked child workspaces can join their observed parent's workflow.

### Runtime-to-visual mapping

Verify exact event types against the installed Pi API before registering handlers.

| Runtime evidence | Required visual behavior |
| --- | --- |
| Session attached/started | Create or reconcile one character; idle until work starts. |
| Agent run starts | Active character at its desk; neutral activity label until a concrete action is known. |
| `tool_execution_start` | Add the tool-call ID to the active set; show the corresponding activity. |
| `tool_execution_end` | Remove only that tool-call ID; show an error badge when that tool failed. |
| `agent_settled`, where supported | Mark the run idle; do not declare the entire workflow complete. |
| Blocking UI prompt begins/ends, where supported | Show/clear an explicit waiting-for-user indicator. |
| Actual task completion from launcher | Mark that delegated task complete. |
| Process exit or session detachment | Remove/deactivate the appropriate live instance without inventing success. |

Pi documents that `agent_end` may precede retries, compaction, or follow-ups. Prefer the verified settled-state notification. With an older version lacking it, use available state evidence conservatively and document the limitation; never equate `agent_end` with successful workflow completion. [S5]

For tool presentation, classify `read`, `grep`, `find`, and `ls` as read-like where available; classify `write` and `edit` as write-like; show `bash` as a command. Unknown tools get their real tool name and a neutral activity. Browser and Figma classifications require the actual installed tool names, not guessed conventions.

Reuse existing reading/typing animations. Do not invent precise task progress, hidden reasoning, or approval states from elapsed time. Hide unavailable token, context, and cost metrics instead of reusing Claude model defaults; display them only from verified Pi data. A generic confirmation dialog is waiting for the user; call it a permission request only when its source explicitly identifies it as one.

**Gate:** a real Pi session appears inside pi-web's `Agents` experience, reads a test file, edits a sandbox file, runs a harmless command, and settles correctly. A failing tool shows an error without permanently failing the agent. Evidence must include a real-runtime test, not only fixture playback.

## 7. Milestone 2 - correct multi-agent tracking

Integrate the actual subagent launcher discovered in Milestone 0. Do not install a different launcher merely because its API is easier.

Capture the parent's instance ID, a newly allocated child instance ID, delegated task ID, and the child's real name/role at launch. Propagate identity before telemetry begins. Nested launches must replace inherited child IDs, not accidentally reuse them. Track cancellation and process termination independently of successful completion.

Support headless or `--no-session` children without requiring transcript files. When child streams are already owned by the launcher, observe that stream without consuming it away from the launcher or writing diagnostics into its JSON stdout.

Prefer full named characters for named specialists. Use the existing teammate model where it fits. If its discovery requires transcript-backed metadata, add the smallest explicit child-registration path rather than manufacturing files. Use the ephemeral representation only for delegated work that genuinely matches it. Do not claim an agent hierarchy that is not observed.

Avoid a duplicate child character when a delegation tool is also shown as an active parent tool. Parent and child tool calls may overlap. Ending the parent turn must not end a still-running child, and one tool finishing must not make an agent with other active tools appear idle.

**Gate:** one parent plus three real concurrent children produce exactly four characters. Test repeated role names, nested children, different working directories, cancellation, and a child that remains active after the parent settles.

If there is no launcher installed, complete independent-session visualization, provide an explicitly labeled fixture for parent/child rendering, and record that live child integration remains unverified. Do not present the fixture as a working multi-agent integration.

## 8. Milestone 3 - inspectable collaboration and human blockers

Instrument existing messaging/delegation functions, not agent prose. Use a small semantic event set as needed:

```text
task.assigned / task.completed / task.cancelled
message.sent / message.delivered / message.failed
discussion.started / discussion.ended
human.requested / human.resolved / human.cancelled
artifact.produced
```

These are proposed orchestration events, not built-in Pi events. Do not add a discussion lifecycle unless the runtime can identify one. A single asynchronous message is not proof that two agents are simultaneously meeting.

Retain sender, recipient, message ID, task/workflow ID, timestamp, source reference, and actual exchanged text subject to the runtime's redaction policy. Show send versus delivery honestly. For human requests, retain request ID, requesting agent, question/options, and resolution status. Agents still receive answers through the existing Pi/orchestrator path.

Select an avatar to inspect its name, role, parent, current task, active tools, latest events, inter-agent messages, blockers, and artifact references. Display unavailable fields as unavailable. Expose actual messages and public outputs; do not collect private reasoning streams or fabricate summaries.

Reuse the orchestrator's durable conversation/decision log as the authoritative source. The office can maintain a bounded read-only cache, but losing the office must not lose those records. If no semantic log exists, implement a minimal append-only local log at the messaging adapter, with stable IDs and send/delivery outcomes; do not add a database. Report logging failures and history gaps rather than claiming complete history. Do not duplicate full model prompts or arbitrary tool output into this log.

**Gate:** a real message can be selected in the office and matched to its source record. A real human request remains visibly unresolved until its corresponding resolution/cancellation event. A question mark in ordinary assistant text must not create a false blocker.

## 9. Milestone 4 - spatial collaboration

Only begin after identity and event correlation pass their tests. Reuse the existing office and assets; do not add another rendering engine or social simulation.

Use the following visual semantics:

| Evidence | Animation |
| --- | --- |
| Named agent becomes active | Walk to assigned desk and work. |
| Asynchronous message | Brief directed envelope/pulse between sender and recipient; preserve message ID for inspection. |
| Explicit live discussion starts | Participants approach a reachable meeting point; show the actual discussion thread. |
| Discussion ends | Participants return to the state/location implied by current runtime activity. |
| Human input requested | Attention bubble; optionally approach the designated PO area. |
| Artifact produced | Small artifact indicator linked to the actual output reference. |
| Telemetry is stale | Clear disconnected indicator, not continued apparent productive work. |

Animation is an asynchronous illustration. It must never gate message delivery, tool execution, approvals, or runtime state changes. Apply the latest state immediately even if a walking animation is unfinished.

Coalesce repetitive cosmetic animations. Do not queue minutes of old walks, create random conversations, or move agents solely to make the office look busy. Idle wandering, if retained, is ambient and must not imply collaboration.

Use existing pathfinding. When no reachable meeting tile exists, use the message indicator without moving characters. Keep normal desk assignment and user-edited layouts intact. Support reduced motion and a static event-list equivalent; do not auto-pan away from the selected agent for every event.

**Gate:** every collaboration animation is traceable to an actual event. An animation can be interrupted by completion, cancellation, or a blocker without leaving the UI in an outdated state.

## 10. Milestone 5 - recovery, safety and packaging

### Delivery and recovery

Telemetry callbacks enqueue quickly and return without awaiting network delivery. Use one ordered, bounded delivery queue per producer with short request timeouts. Throttle partial updates; retain critical lifecycle state or send a fresh snapshot after a gap. Do not retry forever or accumulate unbounded data.

Add a lightweight heartbeat, initially every five seconds. After twenty seconds without one, show disconnected with the last-known state. Disconnected means telemetry is unavailable, not that the task failed or process exited. On reconnect, reconcile an authoritative current-state snapshot and do not replay obsolete motion.

Deduplicate by producer/sequence. Keep per-agent ordering; never compare sequence numbers across unrelated producers. A snapshot needs a sequence boundary so older events cannot overwrite it. Explicitly mark missed history when reconstruction is impossible.

Test extension reload, session replacement, browser refresh, server restart, hard-killed children, duplicate events, and out-of-order delivery. Make resource cleanup idempotent. Closing the office must not kill Pi; observer timers must not keep a finished Pi process alive.

### Security and data minimization

Bind to loopback by default. Reuse authenticated hook delivery and verified registry discovery. Do not broadcast Pi events to unrelated or incompatible office instances. Keep tokens in protected local configuration, not tracked files, screenshots, event history, or browser logs.

Validate payload types and sizes. Render agent text as text, never trusted HTML. Do not execute or automatically fetch artifact references; restrict local file access to explicitly permitted roots and safe link schemes. Do not expose arbitrary filesystem browsing or shell routes.

Do not export API keys, authorization headers, environment variables, full prompts, arbitrary file contents, or shell command arguments by default. Use sanitized activity labels. Keep any deeper content display limited to deliberately captured inter-agent messages and approved artifact references.

Do not enable permission bypass flags. Test installs and consent changes with an isolated home/config directory, not the user's live Claude or Pi settings. Preserve existing Claude security behavior.

### Packaging and usable commands

Deliver a reproducible local setup with a pinned Pixel Agents revision, supported Pi version, install/build commands, launch commands, and removal instructions. Verify the built/package artifact includes the integration files and does not depend on a developer-only absolute path.

Target usage, to implement and verify rather than assume is already supported:

```bash
# In the project whose agents should be observed:
node /path/to/pixel-agents/dist/cli.js --provider pi --host 127.0.0.1

# In another terminal, in the same project:
pi -e /path/to/pixel-agents/integrations/pi/index.ts
```

`--provider pi` above is a proposed new selector unless Milestone 0 finds an equivalent existing option. The extension should discover the compatible local server securely; do not require credentials pasted into shell history. Child setup must be documented for the actual launcher.

## 11. Verification matrix

Implement deterministic tests first, then a real-runtime smoke test in a temporary workspace. No production repository edits or external Figma/Jira writes are needed for validation.

| Scenario | Required result |
| --- | --- |
| Real single agent | One correctly labeled character and accurate tool animation. |
| Same-name concurrent children | Distinct identities and no duplicate avatars. |
| Parent settles before child | Child remains active. |
| Parallel tools | One ending does not clear the others. |
| Failed tool followed by success | Error is recorded; subsequent activity remains possible. |
| Retry/compaction/follow-up | No premature completed-workflow indication. |
| Explicit human prompt | Waiting state appears and clears for that request only. |
| Ordinary text question | No invented blocking/approval state. |
| Real inter-agent message | Correct sender, recipient, delivery state, and source record. |
| Headless child without transcript | Still visible and individually tracked. |
| Reload/new/resume/fork | Correct replacement/reconciliation without stale deletion. |
| Lost observer/server restart | Pi continues; stale marker and snapshot recovery work. |
| Duplicate/out-of-order events | No doubled characters or state regression. |
| Bad token/malformed/oversized event | Rejected without affecting Pi or the office. |
| Text containing HTML/script | Displayed inertly. |
| Unreachable collaboration area | Fallback indicator; no stuck animation. |
| Existing Claude mode | Baseline tests continue to pass. |

Run the repository's type checks, lint, unit/integration tests, relevant browser tests, and build. Check generated protocol files when contracts change. Report commands actually run and their outcomes; do not mark an unexecuted check as passing.

Capture a short screen recording of the real Pi smoke test. Keep any fixture-only recording clearly labeled. Do not incur unbounded LLM usage: use the user's configured model, small prompts, and a small test workspace. If live testing is blocked by missing credentials, report that limitation and the exact remaining check.

## 12. Completion report

Return the branch/revision, changed files, implemented milestones, supported Pi/launcher versions, exact setup commands, tests and recording, known limitations, and rollback/uninstall instructions.

Do not call the full integration complete until real Pi activity and real child tracking have been demonstrated. Do not call collaboration complete unless actual messages and input requests have been correlated. It is acceptable to finish the basic office while explicitly reporting that a missing orchestration API prevents the collaboration milestone.

Start with Milestone 0 and continue through the independent milestones. Resolve discoverable details from the repository instead of asking me to locate source files. Ask only when a genuinely unavailable decision affects safety, scope, or compatibility; otherwise state the assumption and proceed with the smallest reversible change.

## Sources

[S1] Pixel Agents README: https://github.com/pixel-agents-hq/pixel-agents

[S2] Provider contract: https://github.com/pixel-agents-hq/pixel-agents/blob/main/core/src/provider.ts

[S3] Standalone entry point: https://github.com/pixel-agents-hq/pixel-agents/blob/main/server/src/cli.ts

[S4] HTTP/WS implementation: https://github.com/pixel-agents-hq/pixel-agents/blob/main/server/src/httpServer.ts

[S5] Pi extension API: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md

[S6] Pi example subagent launcher: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/subagent/index.ts

[S7] Pixel Agents terminology: https://github.com/pixel-agents-hq/pixel-agents/blob/main/CONTEXT.md

[S8] Team integration contract: https://github.com/pixel-agents-hq/pixel-agents/blob/main/core/src/teamProvider.ts

[S9] Pixel Agents contribution/testing guide: https://github.com/pixel-agents-hq/pixel-agents/blob/main/CONTRIBUTING.md

Additional implementation reference - server registry and lifecycle:
https://github.com/pixel-agents-hq/pixel-agents/blob/main/server/src/server.ts
https://github.com/pixel-agents-hq/pixel-agents/blob/main/server/src/agentRuntime.ts

[S10] Taste Skill design and motion reference: https://www.tasteskill.dev/ (inspiration only; pi-web's existing design system remains authoritative).
