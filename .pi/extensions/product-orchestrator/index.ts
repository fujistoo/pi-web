import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ProductFeatureStore, type ReadinessResult } from "../../../lib/product-state";
import { ProductRunCoordinator } from "../../../lib/product-run";
import { ProductReconciliationCoordinator } from "../../../lib/product-reconciliation";
import { ProductDeliberationBroker, type ProductMessageContent } from "../../../lib/product-messaging";

const ACTIONS = [
  "init",
  "read",
  "start_run",
  "read_run",
  "update_run",
  "add_task",
  "start_task",
  "complete_task",
  "retry_task",
  "mark_tasks_stale",
  "join_run",
  "resume_run",
  "set_run_phase",
  "add_evidence",
  "mark_evidence_stale",
  "invalidate_tasks",
  "read_discussion",
  "resolve_discussion",
  "ask_specialist",
  "send_message",
  "resume_message",
  "record_feedback",
  "propose_external_write",
  "approve_external_write",
  "begin_external_write",
  "record_external_receipt",
  "verify_external_write",
  "reconcile_external_write",
  "write_requirements",
  "write_scenarios",
  "write_design_map",
  "set_specialist_status",
  "record_specialist_result",
  "record_deliberation",
  "request_clarification",
  "record_decision",
  "record_change",
  "update_readiness",
  "readiness",
] as const;

const GATES = ["before_design", "before_feedback", "ready_for_dev"] as const;

type Action = (typeof ACTIONS)[number];
type Gate = ReadinessResult["gate"];

type ProductStateParams = {
  action: Action;
  feature: string;
  data?: unknown;
  gate?: Gate;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function messageContent(data: Record<string, unknown>): ProductMessageContent {
  const content = isRecord(data.content) ? data.content : data;
  return {
    summary: typeof content.summary === "string" ? content.summary : "",
    ...(typeof content.question === "string" ? { question: content.question } : {}),
    ...(typeof content.answer === "string" ? { answer: content.answer } : {}),
    ...(typeof content.reason === "string" ? { reason: content.reason } : {}),
    evidence_refs: Array.isArray(content.evidence_refs) ? content.evidence_refs as string[] : [],
    affected_ids: Array.isArray(content.affected_ids) ? content.affected_ids as string[] : [],
    unresolved: Array.isArray(content.unresolved) ? content.unresolved as string[] : [],
    ...(isRecord(content.details) ? { details: content.details } : {}),
  };
}

function snapshotText(snapshot: ReturnType<ProductFeatureStore["snapshot"]>): string {
  return JSON.stringify({
    state: snapshot.state,
    requirements: snapshot.requirements,
    scenarios: snapshot.scenarios,
    designMap: snapshot.designMap,
    decisions: snapshot.decisions,
    changes: snapshot.changes,
    specialistResults: snapshot.specialistResults,
    clarifications: snapshot.clarifications,
    deliberations: snapshot.deliberations,
    runs: snapshot.runs,
    feedback: snapshot.feedback,
    externalWrites: snapshot.externalWrites,
    verifications: snapshot.verifications,
  }, null, 2);
}

export default function productOrchestratorExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "product_state",
    label: "Product State",
    description: "Create and update the durable Git-backed product record under .product/features/<feature>. Use this for requirements, scenarios, reuse maps, specialist results, deliberations, clarifications, decisions, changes, and readiness gates; never leave product-relevant decisions only in chat history.",
    promptSnippet: "Persist or inspect the durable product-design record and readiness gates",
    promptGuidelines: [
      "Use product_state for every product-relevant decision, deliberation, clarification, specialist result, requirement impact, scenario impact, and design change.",
      "Use product_state readiness before design, before applying material feedback, and before claiming Ready for Dev.",
      "Do not use product_state to silently approve a new business rule; record a clarification and wait for the PO/PM decision.",
    ],
    parameters: Type.Object({
      action: StringEnum(ACTIONS),
      feature: Type.String({ description: "Issue or feature key, for example TK-22015" }),
      data: Type.Optional(Type.Any({ description: "Action-specific structured data" })),
      gate: Type.Optional(StringEnum(GATES)),
    }),
    async execute(_toolCallId, params: ProductStateParams, _signal, _onUpdate, ctx) {
      const store = new ProductFeatureStore(ctx.cwd, params.feature);
      const data = params.data;
      let result: unknown;
      switch (params.action) {
        case "init":
          result = store.ensure();
          break;
        case "read":
          result = store.snapshot();
          break;
        case "start_run":
          if (!isRecord(data)) throw new Error("start_run requires structured data");
          result = ProductRunCoordinator.start(store, data);
          if (isRecord(result)) {
            const broker = new ProductDeliberationBroker({ cwd: ctx.cwd, feature: params.feature, runId: result.id as string });
            await broker.registerParticipant({ role: "orchestrator", sessionId: ctx.sessionManager.getSessionId(), status: "running" });
            result = store.getRun(result.id as string) ?? result;
          }
          break;
        case "read_run":
          if (!isRecord(data) || typeof data.id !== "string") throw new Error("read_run requires an id");
          result = store.getRun(data.id);
          if (!result) throw new Error(`Run not found: ${data.id}`);
          break;
        case "update_run":
          if (!isRecord(data) || typeof data.id !== "string") throw new Error("update_run requires an id");
          result = store.updateRun(data.id, data);
          break;
        case "add_task":
          if (!isRecord(data) || typeof data.run_id !== "string") throw new Error("add_task requires run_id");
          result = await new ProductRunCoordinator({ store, runId: data.run_id }).addTask(data);
          break;
        case "start_task":
          if (!isRecord(data) || typeof data.run_id !== "string" || typeof data.task_id !== "string") throw new Error("start_task requires run_id and task_id");
          result = await new ProductRunCoordinator({ store, runId: data.run_id }).startTask(data.task_id);
          break;
        case "complete_task":
          if (!isRecord(data) || typeof data.run_id !== "string" || typeof data.task_id !== "string" || !isRecord(data.outcome)) throw new Error("complete_task requires run_id, task_id, and outcome");
          result = await new ProductRunCoordinator({ store, runId: data.run_id }).completeTask(data.task_id, data.outcome as never);
          break;
        case "retry_task":
          if (!isRecord(data) || typeof data.run_id !== "string" || typeof data.task_id !== "string") throw new Error("retry_task requires run_id and task_id");
          result = await new ProductRunCoordinator({ store, runId: data.run_id }).retryTask(data.task_id, typeof data.reason === "string" ? data.reason : undefined);
          break;
        case "mark_tasks_stale":
          if (!isRecord(data) || typeof data.run_id !== "string" || !Array.isArray(data.task_ids) || typeof data.reason !== "string") throw new Error("mark_tasks_stale requires run_id, task_ids, and reason");
          result = await new ProductRunCoordinator({ store, runId: data.run_id }).markTaskStale(data.task_ids as string[], data.reason);
          break;
        case "join_run":
          if (!isRecord(data) || typeof data.run_id !== "string") throw new Error("join_run requires run_id");
          result = new ProductRunCoordinator({ store, runId: data.run_id }).join();
          break;
        case "resume_run":
          if (!isRecord(data) || typeof data.run_id !== "string") throw new Error("resume_run requires run_id");
          result = await new ProductRunCoordinator({ store, runId: data.run_id }).resume();
          break;
        case "set_run_phase":
          if (!isRecord(data) || typeof data.run_id !== "string" || typeof data.phase !== "string") throw new Error("set_run_phase requires run_id and phase");
          result = await new ProductRunCoordinator({ store, runId: data.run_id }).setPhase(data.phase as never, typeof data.status === "string" ? data.status as never : undefined);
          break;
        case "add_evidence":
          if (!isRecord(data) || typeof data.run_id !== "string") throw new Error("add_evidence requires run_id");
          result = await new ProductRunCoordinator({ store, runId: data.run_id }).addEvidence(data);
          break;
        case "mark_evidence_stale":
          if (!isRecord(data) || typeof data.run_id !== "string" || !Array.isArray(data.evidence_ids) || typeof data.reason !== "string") throw new Error("mark_evidence_stale requires run_id, evidence_ids, and reason");
          result = await new ProductRunCoordinator({ store, runId: data.run_id }).markEvidenceStale(data.evidence_ids as string[], data.reason);
          break;
        case "invalidate_tasks":
          if (!isRecord(data) || typeof data.run_id !== "string" || !Array.isArray(data.affected_ids) || typeof data.reason !== "string") throw new Error("invalidate_tasks requires run_id, affected_ids, and reason");
          result = await new ProductRunCoordinator({ store, runId: data.run_id }).invalidateByAffectedIds(data.affected_ids as string[], data.reason);
          break;
        case "read_discussion":
          if (!isRecord(data) || typeof data.id !== "string") throw new Error("read_discussion requires an id");
          result = store.getDiscussion(data.id);
          if (!result) throw new Error(`Discussion not found: ${data.id}`);
          break;
        case "resolve_discussion":
          if (!isRecord(data) || typeof data.id !== "string") throw new Error("resolve_discussion requires an id");
          result = store.resolveDiscussion(data.id, data);
          break;
        case "ask_specialist":
          if (!isRecord(data) || typeof data.run_id !== "string" || typeof data.recipient_role !== "string") throw new Error("ask_specialist requires run_id and recipient_role");
          result = await new ProductDeliberationBroker({ cwd: ctx.cwd, feature: params.feature, runId: data.run_id }).ask({
            senderRole: "orchestrator",
            senderSessionId: ctx.sessionManager.getSessionId(),
            recipientRole: data.recipient_role as never,
            content: messageContent(data),
          }, { waitMs: typeof data.wait_ms === "number" ? data.wait_ms : 0, signal: _signal });
          break;
        case "send_message":
          if (!isRecord(data) || typeof data.run_id !== "string" || typeof data.recipient_role !== "string" || typeof data.kind !== "string") throw new Error("send_message requires run_id, recipient_role, and kind");
          result = await new ProductDeliberationBroker({ cwd: ctx.cwd, feature: params.feature, runId: data.run_id }).send({
            kind: data.kind as never,
            senderRole: "orchestrator",
            senderSessionId: ctx.sessionManager.getSessionId(),
            recipientRole: data.recipient_role as never,
            recipientSessionId: typeof data.recipient_session_id === "string" ? data.recipient_session_id : undefined,
            discussionId: typeof data.discussion_id === "string" ? data.discussion_id : undefined,
            replyTo: typeof data.reply_to === "string" ? data.reply_to : undefined,
            content: messageContent(data),
          });
          break;
        case "resume_message":
          if (!isRecord(data) || typeof data.run_id !== "string" || typeof data.message_id !== "string") throw new Error("resume_message requires run_id and message_id");
          result = new ProductDeliberationBroker({ cwd: ctx.cwd, feature: params.feature, runId: data.run_id }).resume(data.message_id) ?? null;
          break;
        case "record_feedback":
          if (!isRecord(data)) throw new Error("record_feedback requires structured data");
          result = new ProductReconciliationCoordinator(store).recordFeedback(data);
          break;
        case "propose_external_write":
          if (!isRecord(data)) throw new Error("propose_external_write requires structured data");
          result = new ProductReconciliationCoordinator(store).proposeExternalWrite(data);
          break;
        case "approve_external_write":
          if (!isRecord(data) || typeof data.id !== "string" || typeof data.decision_id !== "string") throw new Error("approve_external_write requires id and decision_id");
          result = new ProductReconciliationCoordinator(store).approveExternalWrite(data.id, { decision_id: data.decision_id, ...(typeof data.approved_by === "string" ? { approved_by: data.approved_by } : {}) });
          break;
        case "begin_external_write":
          if (!isRecord(data) || typeof data.id !== "string") throw new Error("begin_external_write requires id");
          result = new ProductReconciliationCoordinator(store).beginExternalWrite(data.id);
          break;
        case "record_external_receipt":
          if (!isRecord(data) || typeof data.id !== "string" || !isRecord(data.receipt)) throw new Error("record_external_receipt requires id and receipt");
          result = new ProductReconciliationCoordinator(store).recordExternalReceipt(data.id, data.receipt);
          break;
        case "verify_external_write":
          if (!isRecord(data) || typeof data.id !== "string" || !isRecord(data.verification)) throw new Error("verify_external_write requires id and verification");
          result = new ProductReconciliationCoordinator(store).verifyExternalWrite(data.id, data.verification as never);
          break;
        case "reconcile_external_write":
          if (!isRecord(data) || typeof data.id !== "string") throw new Error("reconcile_external_write requires id");
          result = new ProductReconciliationCoordinator(store).reconcileExternalWrite(data.id);
          break;
        case "write_requirements":
          if (!isRecord(data)) throw new Error("write_requirements requires structured data");
          result = store.writeRequirements(data);
          break;
        case "write_scenarios":
          if (!isRecord(data)) throw new Error("write_scenarios requires structured data");
          result = store.writeScenarios(data);
          break;
        case "write_design_map":
          if (!isRecord(data)) throw new Error("write_design_map requires structured data");
          result = store.writeDesignMap(data);
          break;
        case "set_specialist_status":
          if (!isRecord(data)) throw new Error("set_specialist_status requires structured data");
          result = store.setSpecialistStatus(data);
          break;
        case "record_specialist_result":
          if (!isRecord(data)) throw new Error("record_specialist_result requires structured data");
          result = store.recordSpecialistResult(data);
          break;
        case "record_deliberation":
          if (!isRecord(data)) throw new Error("record_deliberation requires structured data");
          result = store.recordDeliberation(data);
          break;
        case "request_clarification":
          if (!isRecord(data)) throw new Error("request_clarification requires structured data");
          result = store.requestClarification(data);
          break;
        case "record_decision":
          if (!isRecord(data)) throw new Error("record_decision requires structured data");
          result = store.recordDecision(data);
          break;
        case "record_change":
          if (!isRecord(data)) throw new Error("record_change requires structured data");
          result = store.recordChange(data);
          break;
        case "update_readiness":
          if (!isRecord(data)) throw new Error("update_readiness requires structured data");
          result = store.updateReadiness(data);
          break;
        case "readiness":
          result = store.readiness(params.gate ?? "before_design");
          break;
      }

      const text = ["init", "read", "read_run", "read_discussion", "start_run", "update_run", "add_task", "start_task", "complete_task", "retry_task", "mark_tasks_stale", "join_run", "resume_run", "set_run_phase", "add_evidence", "mark_evidence_stale", "invalidate_tasks", "ask_specialist", "send_message", "resume_message", "record_feedback", "propose_external_write", "approve_external_write", "begin_external_write", "record_external_receipt", "verify_external_write", "reconcile_external_write"].includes(params.action)
        ? JSON.stringify(result, null, 2)
        : params.action === "readiness" || params.action === "record_deliberation" || params.action === "resolve_discussion"
          ? JSON.stringify(result, null, 2)
          : `Persisted ${params.action} for ${params.feature}.\n${snapshotText((result as ReturnType<ProductFeatureStore["snapshot"]>))}`;
      return {
        content: [{ type: "text", text }],
        details: { action: params.action, feature: params.feature, result },
      };
    },
  });
}
