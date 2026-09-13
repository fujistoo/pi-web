import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import {
  ProductFeatureStore,
  type ProductDiscussionRecord,
  type ProductRunRecord,
} from "./product-state";

export const PRODUCT_MESSAGE_KINDS = [
  "clarification",
  "challenge",
  "proposal",
  "evidence",
  "counterproposal",
  "impact-analysis",
  "approval-request",
  "resolution",
  "question",
  "answer",
  "status",
] as const;

export type ProductMessageKind = (typeof PRODUCT_MESSAGE_KINDS)[number];
export type ProductAgentRole = "orchestrator" | "prd" | "archaeology" | "rbac" | "ux" | "qa";
export type ProductParticipantStatus = "registered" | "running" | "waiting" | "complete" | "blocked" | "failed";
export type ProductDeliveryStatus = "accepted" | "queued" | "delivered" | "acknowledged" | "answered" | "rejected" | "expired" | "stale";

export interface ProductAgentRef {
  role: ProductAgentRole;
  session_id: string | null;
}

export interface ProductMessageContent {
  summary: string;
  question?: string;
  answer?: string;
  reason?: string;
  evidence_refs: string[];
  affected_ids: string[];
  unresolved: string[];
  details?: Record<string, unknown>;
}

export interface ProductDelivery {
  status: ProductDeliveryStatus;
  attempts: number;
  last_error?: string;
  delivered_at?: string;
  acknowledged_at?: string;
}

export interface ProductMessage {
  version: 1;
  feature: string;
  message_id: string;
  run_id: string;
  discussion_id: string;
  kind: ProductMessageKind;
  sender: ProductAgentRef;
  recipient: ProductAgentRef;
  reply_to: string | null;
  requirements_baseline: number | null;
  content: ProductMessageContent;
  created_at: string;
  delivery: ProductDelivery;
}

export interface ProductParticipant {
  role: ProductAgentRole;
  session_id: string;
  parent_session_id?: string;
  status: ProductParticipantStatus;
  registered_at: string;
  updated_at: string;
}

export interface ProductMessageInput {
  discussionId?: string;
  kind: ProductMessageKind;
  senderRole: ProductAgentRole;
  senderSessionId: string;
  recipientRole: ProductAgentRole;
  recipientSessionId?: string;
  messageId?: string;
  replyTo?: string | null;
  requirementsBaseline?: number | null;
  content: ProductMessageContent;
}

export interface ProductSendReceipt {
  status: ProductDeliveryStatus;
  message_id: string;
  discussion_id: string;
  recipient: ProductAgentRef;
  duplicate: boolean;
  error?: string;
}

export interface ProductAskReceipt extends ProductSendReceipt {
  answer?: ProductMessage;
}

export interface ProductMessageTransport {
  deliver(input: { sessionId: string; message: ProductMessage; prompt: string }): Promise<void>;
}

export interface ProductSubagentContext {
  feature: string;
  runId: string;
  role: ProductAgentRole;
  taskId?: string;
}

let configuredTransport: ProductMessageTransport | undefined;
const brokerRegistry = new Map<string, ProductDeliberationBroker>();
const mutationQueues = new Map<string, Promise<void>>();

async function withMutationLock<T>(key: string, operation: () => T | Promise<T>): Promise<T> {
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  mutationQueues.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (mutationQueues.get(key) === current) mutationQueues.delete(key);
  }
}

export function configureProductMessageTransport(transport: ProductMessageTransport | undefined): void {
  configuredTransport = transport;
}

export function clearProductMessageBrokers(): void {
  brokerRegistry.clear();
}

function assertRole(value: string): ProductAgentRole {
  if (["orchestrator", "prd", "archaeology", "rbac", "ux", "qa"].includes(value)) {
    return value as ProductAgentRole;
  }
  throw new Error(`Unknown product agent role: ${value}`);
}

function assertSessionId(value: string): string {
  const sessionId = value.trim();
  if (!sessionId) throw new Error("Product agent session id is required");
  return sessionId;
}

function assertMessageKind(value: string): ProductMessageKind {
  if ((PRODUCT_MESSAGE_KINDS as readonly string[]).includes(value)) return value as ProductMessageKind;
  throw new Error(`Unknown product message kind: ${value}`);
}

function normalizeContent(content: ProductMessageContent): ProductMessageContent {
  if (!content || typeof content !== "object") throw new Error("Product message content is required");
  const summary = typeof content.summary === "string" ? content.summary.trim() : "";
  if (!summary) throw new Error("Product message summary is required");
  for (const field of ["evidence_refs", "affected_ids", "unresolved"] as const) {
    if (!Array.isArray(content[field]) || !content[field].every((item) => typeof item === "string")) {
      throw new Error(`Product message ${field} must be an array of strings`);
    }
  }
  return {
    ...content,
    summary,
    evidence_refs: [...content.evidence_refs],
    affected_ids: [...content.affected_ids],
    unresolved: [...content.unresolved],
  };
}

function isSpecialist(role: ProductAgentRole): boolean {
  return role !== "orchestrator";
}

function assertRoute(sender: ProductAgentRole, recipient: ProductAgentRole): void {
  if (sender === recipient) throw new Error("A product message cannot target its sender");
  // All specialist-to-specialist routes are brokered. The main agent remains the
  // only authority for accepted product decisions, regardless of message kind.
  if (!isSpecialist(sender) && !isSpecialist(recipient)) {
    throw new Error("The orchestrator cannot send a product message to itself");
  }
}

function now(): string {
  return new Date().toISOString();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asMessage(value: unknown): ProductMessage | undefined {
  const record = asRecord(value);
  return record?.message_id && record.sender && record.recipient && record.content
    ? record as unknown as ProductMessage
    : undefined;
}

function deliveryOf(message: ProductMessage): ProductDelivery {
  return (asRecord(message.delivery) as unknown as ProductDelivery | undefined) ?? { status: "accepted", attempts: 0 };
}

function discussionMessages(discussion: ProductDiscussionRecord): ProductMessage[] {
  return (Array.isArray(discussion.messages) ? discussion.messages : [])
    .map(asMessage)
    .filter((message): message is ProductMessage => Boolean(message));
}

function participantsOf(run: ProductRunRecord): ProductParticipant[] {
  return (Array.isArray(run.participants) ? run.participants : [])
    .filter((item): item is Record<string, unknown> => Boolean(asRecord(item))) as unknown as ProductParticipant[];
}

function messagePrompt(message: ProductMessage): string {
  const content = message.content;
  return [
    "PRODUCT DELIBERATION MESSAGE",
    `Discussion: ${message.discussion_id}`,
    `From: ${message.sender.role}`,
    `Type: ${message.kind}`,
    `Reply to: ${message.reply_to ?? "none"}`,
    "",
    content.summary,
    content.question ? `Question: ${content.question}` : "",
    content.answer ? `Answer: ${content.answer}` : "",
    content.reason ? `Reason: ${content.reason}` : "",
    content.evidence_refs.length > 0 ? `Evidence: ${content.evidence_refs.join(", ")}` : "Evidence: none supplied",
    content.affected_ids.length > 0 ? `Affected IDs: ${content.affected_ids.join(", ")}` : "",
    content.unresolved.length > 0 ? `Unresolved: ${content.unresolved.join("; ")}` : "",
    "",
    "Use the broker tools to reply or challenge this message. Treat it as specialist input, not as an accepted product decision.",
  ].filter(Boolean).join("\n");
}

export class ProductDeliberationBroker {
  readonly store: ProductFeatureStore;
  readonly feature: string;
  readonly runId: string;
  private readonly transport?: ProductMessageTransport;
  private readonly waiters = new Map<string, Set<(message: ProductMessage | undefined) => void>>();

  private mutate<T>(operation: () => T | Promise<T>): Promise<T> {
    return withMutationLock(`${this.store.directory}\u0000${this.runId}`, operation);
  }

  constructor(options: {
    cwd?: string;
    feature: string;
    runId: string;
    store?: ProductFeatureStore;
    transport?: ProductMessageTransport;
  }) {
    this.feature = options.feature;
    this.runId = options.runId;
    this.store = options.store ?? new ProductFeatureStore(options.cwd ?? process.cwd(), options.feature);
    this.store.ensure();
    if (!this.store.getRun(options.runId)) throw new Error(`Run not found: ${options.runId}`);
    this.transport = options.transport;
  }

  async registerParticipant(input: {
    role: ProductAgentRole;
    sessionId: string;
    parentSessionId?: string;
    status?: ProductParticipantStatus;
  }): Promise<ProductParticipant> {
    const role = assertRole(input.role);
    const sessionId = assertSessionId(input.sessionId);
    const registeredStatus = input.status ?? "registered";
    if (!["registered", "running", "waiting", "complete", "blocked", "failed"].includes(registeredStatus)) {
      throw new Error(`Invalid participant status: ${registeredStatus}`);
    }
    const registered: ProductParticipant = {
      role,
      session_id: sessionId,
      ...(input.parentSessionId ? { parent_session_id: input.parentSessionId } : {}),
      status: registeredStatus,
      registered_at: now(),
      updated_at: now(),
    };
    await this.mutate(() => {
      const run = this.requireRun();
      const participants = Array.isArray(run.participants) ? run.participants.filter((item) => asRecord(item)) : [];
      const next = participants.filter((item) => item.session_id !== sessionId);
      next.push(registered as unknown as Record<string, unknown>);
      this.store.updateRun(this.runId, { participants: next });
    });
    await this.flushQueued(role, sessionId);
    return registered;
  }

  async updateParticipant(sessionId: string, status: ProductParticipantStatus): Promise<ProductRunRecord> {
    const participantStatus = status;
    if (!["registered", "running", "waiting", "complete", "blocked", "failed"].includes(participantStatus)) {
      throw new Error(`Invalid participant status: ${participantStatus}`);
    }
    return this.mutate(() => {
      const run = this.requireRun();
      const participants = participantsOf(run);
      const next = participants.map((item) => item.session_id === sessionId
        ? { ...item, status, updated_at: now() }
        : item);
      return this.store.updateRun(this.runId, { participants: next });
    });
  }

  async send(input: ProductMessageInput): Promise<ProductSendReceipt> {
    const senderRole = assertRole(input.senderRole);
    const recipientRole = assertRole(input.recipientRole);
    assertRoute(senderRole, recipientRole);
    const senderSessionId = assertSessionId(input.senderSessionId);
    const content = normalizeContent(input.content);
    const persisted = await this.mutate(() => {
      const run = this.requireRun();
      this.assertParticipant(run, senderRole, senderSessionId);
      const durableExisting = input.messageId ? this.findMessageInRun(input.messageId) : undefined;
      if (durableExisting) {
        const same = durableExisting.kind === assertMessageKind(input.kind)
          && durableExisting.sender.role === senderRole
          && durableExisting.sender.session_id === senderSessionId
          && durableExisting.recipient.role === recipientRole
          && (!input.recipientSessionId || durableExisting.recipient.session_id === input.recipientSessionId)
          && durableExisting.content.summary === content.summary
          && durableExisting.reply_to === (input.replyTo ?? null)
          && (!input.discussionId || durableExisting.discussion_id === input.discussionId);
        if (!same) throw new Error(`Message id already exists with different content: ${input.messageId}`);
        return {
          discussion: this.requireDiscussion(durableExisting.discussion_id),
          message: durableExisting,
          duplicate: true,
        };
      }
      const repliedMessage = input.replyTo ? this.findMessageInRun(input.replyTo) : undefined;
      if (input.replyTo && !repliedMessage) throw new Error(`Message not found: ${input.replyTo}`);
      const discussion = input.discussionId
        ? this.requireDiscussion(input.discussionId)
        : repliedMessage
          ? this.requireDiscussion(repliedMessage.discussion_id)
          : this.store.createDiscussion({
          run_id: this.runId,
          topic: content.summary,
          raised_by: senderRole,
        });
      if (discussion.run_id !== this.runId) throw new Error(`Discussion ${discussion.id} belongs to another run`);
      if (["resolved", "escalated", "blocked"].includes(discussion.status)) throw new Error(`Discussion is closed: ${discussion.id}`);
      const existingMessages = Array.isArray(discussion.messages) ? discussion.messages : [];
      const maxRounds = typeof discussion.max_rounds === "number" && Number.isInteger(discussion.max_rounds) ? discussion.max_rounds : 8;
      if (existingMessages.length >= maxRounds) throw new Error(`Discussion round limit reached: ${discussion.id}`);
      if (typeof discussion.deadline_at === "string" && Date.parse(discussion.deadline_at) <= Date.now()) throw new Error(`Discussion deadline passed: ${discussion.id}`);
      const recipient = this.resolveRecipient(recipientRole, input.recipientSessionId);
      const baseline = input.requirementsBaseline === undefined
        ? run.requirements_baseline
        : input.requirementsBaseline;
      const stale = baseline !== run.requirements_baseline;
      const appended = this.store.appendDiscussionMessage(discussion.id, {
        version: 1,
        feature: this.feature,
        run_id: this.runId,
        discussion_id: discussion.id,
        ...(input.messageId ? { message_id: input.messageId } : {}),
        kind: assertMessageKind(input.kind),
        sender: { role: senderRole, session_id: senderSessionId },
        recipient,
        reply_to: input.replyTo ?? null,
        requirements_baseline: baseline,
        content,
        delivery: {
          status: stale ? "stale" : "queued",
          attempts: 0,
          ...(stale ? { last_error: `Message baseline ${String(baseline)} does not match run baseline ${String(run.requirements_baseline)}` } : {}),
        },
      });
      return appended;
    });
    const message = persisted.message as unknown as ProductMessage;
    const recipient = message.recipient;
    const existingDelivery = deliveryOf(message);
    if (existingDelivery.status !== "stale" && (!persisted.duplicate || existingDelivery.status === "queued")) await this.deliver(message);
    const updated = this.findMessage(message.discussion_id, message.message_id) ?? message;
    const delivery = deliveryOf(updated);
    return {
      status: delivery.status,
      message_id: updated.message_id,
      discussion_id: updated.discussion_id,
      recipient,
      duplicate: persisted.duplicate,
      ...(delivery.last_error ? { error: delivery.last_error } : {}),
    };
  }

  async ask(input: Omit<ProductMessageInput, "kind">, options: { waitMs?: number; signal?: AbortSignal } = {}): Promise<ProductAskReceipt> {
    const receipt = await this.send({ ...input, kind: "question" });
    const answer = this.findReply(receipt.discussion_id, receipt.message_id);
    if (answer) return { ...receipt, status: "answered", answer };
    if (receipt.status === "stale") return receipt;
    const waitMs = Math.max(0, Math.min(options.waitMs ?? 30_000, 10 * 60_000));
    if (waitMs === 0) return receipt;
    const result = await this.waitForReply(receipt.discussion_id, receipt.message_id, waitMs, options.signal);
    return result ? { ...receipt, status: "answered", answer: result } : receipt;
  }

  async reply(input: {
    messageId: string;
    senderRole: ProductAgentRole;
    senderSessionId: string;
    content: ProductMessageContent;
    requirementsBaseline?: number | null;
  }): Promise<ProductSendReceipt> {
    const original = this.findMessageInRun(input.messageId);
    if (!original) throw new Error(`Message not found: ${input.messageId}`);
    if (original.recipient.role !== assertRole(input.senderRole)) {
      throw new Error(`Role ${input.senderRole} cannot answer ${input.messageId}`);
    }
    if (original.recipient.session_id && original.recipient.session_id !== input.senderSessionId) {
      throw new Error(`Session ${input.senderSessionId} cannot answer ${input.messageId}`);
    }
    const receipt = await this.send({
      discussionId: original.discussion_id,
      kind: "answer",
      senderRole: input.senderRole,
      senderSessionId: input.senderSessionId,
      recipientRole: original.sender.role,
      recipientSessionId: original.sender.session_id ?? undefined,
      replyTo: original.message_id,
      requirementsBaseline: input.requirementsBaseline,
      content: input.content,
    });
    const answer = this.findMessage(original.discussion_id, receipt.message_id);
    if (answer) {
      await this.mutate(() => {
        const current = this.findMessage(original.discussion_id, original.message_id) ?? original;
        const delivery = deliveryOf(current);
        this.store.updateDiscussionMessage(original.discussion_id, original.message_id, {
          delivery: { ...delivery, status: "answered" },
        });
      });
      this.resolveWaiters(original.message_id, answer);
    }
    return receipt;
  }

  async acknowledge(messageId: string, role: ProductAgentRole, sessionId: string): Promise<ProductMessage> {
    const message = this.findMessageInRun(messageId);
    if (!message) throw new Error(`Message not found: ${messageId}`);
    if (message.recipient.role !== assertRole(role) || message.recipient.session_id !== sessionId) {
      throw new Error(`Session ${sessionId} cannot acknowledge ${messageId}`);
    }
    const normalizedSessionId = assertSessionId(sessionId);
    const normalizedRole = assertRole(role);
    this.assertParticipant(this.requireRun(), normalizedRole, normalizedSessionId);
    await this.mutate(() => {
      const current = this.findMessage(message.discussion_id, messageId) ?? message;
      const delivery = deliveryOf(current);
      this.store.updateDiscussionMessage(message.discussion_id, messageId, {
        delivery: { ...delivery, status: "acknowledged", acknowledged_at: now() },
      });
    });
    return this.findMessage(message.discussion_id, messageId) ?? message;
  }

  resume(messageId: string): ProductMessage | undefined {
    const original = this.findMessageInRun(messageId);
    if (!original) throw new Error(`Message not found: ${messageId}`);
    return this.findReply(original.discussion_id, messageId);
  }

  async resolveDiscussion(discussionId: string, data: Record<string, unknown>): Promise<ProductDiscussionRecord> {
    const discussion = this.requireDiscussion(discussionId);
    return this.mutate(() => this.store.resolveDiscussion(discussion.id, data));
  }

  getDiscussion(discussionId: string): ProductDiscussionRecord {
    return this.requireDiscussion(discussionId);
  }

  private requireRun(): ProductRunRecord {
    const run = this.store.getRun(this.runId);
    if (!run) throw new Error(`Run not found: ${this.runId}`);
    return run;
  }

  private requireDiscussion(discussionId: string): ProductDiscussionRecord {
    const discussion = this.store.getDiscussion(discussionId);
    if (!discussion) throw new Error(`Discussion not found: ${discussionId}`);
    return discussion;
  }

  private resolveRecipient(role: ProductAgentRole, sessionId?: string): ProductAgentRef {
    const participants = participantsOf(this.requireRun());
    if (sessionId) {
      const exact = participants.find((participant) => participant.session_id === sessionId);
      if (!exact) throw new Error(`Recipient session is not registered: ${sessionId}`);
      if (exact.role !== role) throw new Error(`Session ${sessionId} is not the ${role} participant`);
      return { role, session_id: exact.session_id };
    }
    const participant = [...participants].reverse().find((item) =>
      item.role === role && item.status !== "complete" && item.status !== "failed" && item.status !== "blocked",
    );
    return { role, session_id: participant?.session_id ?? null };
  }

  private assertParticipant(run: ProductRunRecord, role: ProductAgentRole, sessionId: string): void {
    const participant = participantsOf(run).find((item) => item.session_id === sessionId);
    if (!participant) throw new Error(`Sender session is not registered: ${sessionId}`);
    if (participant.role !== role) throw new Error(`Session ${sessionId} is not the ${role} participant`);
    if (["complete", "failed", "blocked"].includes(participant.status)) {
      throw new Error(`Participant ${sessionId} is no longer active`);
    }
  }

  private async deliver(message: ProductMessage): Promise<void> {
    const prepared = await this.mutate(() => {
      const current = this.findMessage(message.discussion_id, message.message_id) ?? message;
      const delivery = deliveryOf(current);
      const queued = {
        ...current,
        delivery: { ...delivery, status: "queued", attempts: delivery.attempts + 1 },
      } as ProductMessage;
      this.store.updateDiscussionMessage(message.discussion_id, message.message_id, { delivery: queued.delivery });
      return queued;
    });
    const recipientSessionId = prepared.recipient.session_id;
    const transport = this.transport ?? configuredTransport;
    if (!recipientSessionId || !transport) return;
    try {
      await transport.deliver({ sessionId: recipientSessionId, message: prepared, prompt: messagePrompt(prepared) });
      await this.mutate(() => {
        const current = this.findMessage(prepared.discussion_id, prepared.message_id) ?? prepared;
        const delivery = deliveryOf(current);
        this.store.updateDiscussionMessage(prepared.discussion_id, prepared.message_id, {
          delivery: { ...delivery, status: "delivered", delivered_at: now() },
        });
      });
    } catch (error) {
      await this.mutate(() => {
        const current = this.findMessage(prepared.discussion_id, prepared.message_id) ?? prepared;
        const delivery = deliveryOf(current);
        this.store.updateDiscussionMessage(prepared.discussion_id, prepared.message_id, {
          delivery: {
            ...delivery,
            status: "queued",
            last_error: error instanceof Error ? error.message : String(error),
          },
        });
      });
    }
  }

  private findMessage(discussionId: string, messageId: string): ProductMessage | undefined {
    const discussion = this.store.getDiscussion(discussionId);
    return discussion ? discussionMessages(discussion).find((message) => message.message_id === messageId) : undefined;
  }

  private findMessageInRun(messageId: string): ProductMessage | undefined {
    return this.store.snapshot().deliberations
      .flatMap((item) => {
        const discussion = asRecord(item) as ProductDiscussionRecord | undefined;
        return discussion ? discussionMessages(discussion) : [];
      })
      .find((message) => message.run_id === this.runId && message.message_id === messageId);
  }

  private findReply(discussionId: string, messageId: string): ProductMessage | undefined {
    const discussion = this.store.getDiscussion(discussionId);
    return discussion
      ? discussionMessages(discussion).find((message) => message.reply_to === messageId && message.kind === "answer")
      : undefined;
  }

  private waitForReply(discussionId: string, messageId: string, waitMs: number, signal?: AbortSignal): Promise<ProductMessage | undefined> {
    const existing = this.findReply(discussionId, messageId);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolveReply) => {
      const waiters = this.waiters.get(messageId) ?? new Set();
      const finish = (message: ProductMessage | undefined) => {
        clearTimeout(timer);
        clearInterval(poller);
        signal?.removeEventListener("abort", abort);
        waiters.delete(finish);
        if (waiters.size === 0) this.waiters.delete(messageId);
        resolveReply(message);
      };
      const abort = () => finish(undefined);
      const poller = setInterval(() => {
        const answer = this.findReply(discussionId, messageId);
        if (answer) finish(answer);
      }, 250);
      const timer = setTimeout(() => finish(this.findReply(discussionId, messageId)), waitMs);
      waiters.add(finish);
      this.waiters.set(messageId, waiters);
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }

  private resolveWaiters(messageId: string, message: ProductMessage): void {
    const waiters = this.waiters.get(messageId);
    if (!waiters) return;
    for (const waiter of [...waiters]) waiter(message);
  }

  private async flushQueued(role: ProductAgentRole, sessionId: string): Promise<void> {
    for (const item of this.store.snapshot().deliberations) {
      const discussion = asRecord(item) as ProductDiscussionRecord | undefined;
      if (!discussion) continue;
      for (const message of discussionMessages(discussion)) {
        const delivery = deliveryOf(message);
        if (message.recipient.role !== role || delivery.status !== "queued") continue;
        const targeted = message.recipient.session_id === null || message.recipient.session_id === sessionId;
        if (!targeted) continue;
        const updated = await this.mutate(() => {
          const current = this.findMessage(message.discussion_id, message.message_id);
          if (!current || deliveryOf(current).status !== "queued") return undefined;
          const next = { ...current, recipient: { ...current.recipient, session_id: sessionId } };
          this.store.updateDiscussionMessage(message.discussion_id, message.message_id, { recipient: next.recipient });
          return next;
        });
        if (!updated) continue;
        await this.deliver(updated);
      }
    }
  }
}

export function getProductDeliberationBroker(cwd: string, feature: string, runId: string): ProductDeliberationBroker {
  const key = `${resolve(cwd)}\u0000${feature}\u0000${runId}`;
  const existing = brokerRegistry.get(key);
  if (existing) return existing;
  const broker = new ProductDeliberationBroker({ cwd, feature, runId });
  brokerRegistry.set(key, broker);
  return broker;
}

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

function toolError(error: unknown) {
  return {
    content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
    details: undefined,
    isError: true,
  };
}

export function createProductMessagingTools(options: {
  broker: ProductDeliberationBroker;
  role: ProductAgentRole;
  getSessionId: () => string;
}): ToolDefinition[] {
  const { broker, role, getSessionId } = options;
  return [
    defineTool({
      name: "specialist_ask",
      label: "Ask specialist",
      description: "Ask another product specialist a bounded, evidence-bearing question through the orchestrator broker.",
      promptSnippet: "Ask another specialist through the durable product deliberation broker",
      promptGuidelines: [
        "Ask only when the current evidence cannot resolve a material cross-domain ambiguity or contradiction.",
        "Name the affected requirement, scenario, or design IDs and include evidence references.",
        "Treat the answer as specialist input; only the main Product Orchestrator can accept a product decision.",
      ],
      parameters: Type.Object({
        target: Type.String({ description: "Recipient specialist role." }),
        question: Type.String({ description: "The precise question to resolve." }),
        reason: Type.Optional(Type.String({ description: "Why the question is needed." })),
        evidence_refs: Type.Optional(Type.Array(Type.String())),
        affected_ids: Type.Optional(Type.Array(Type.String())),
        wait_ms: Type.Optional(Type.Number({ minimum: 0, maximum: 600000 })),
      }),
      async execute(_toolCallId, params, signal) {
        try {
          return toolResult(await broker.ask({
            senderRole: role,
            senderSessionId: getSessionId(),
            recipientRole: assertRole(params.target),
            content: {
              summary: params.question,
              question: params.question,
              ...(params.reason ? { reason: params.reason } : {}),
              evidence_refs: params.evidence_refs ?? [],
              affected_ids: params.affected_ids ?? [],
              unresolved: [],
            },
          }, { waitMs: params.wait_ms, signal }));
        } catch (error) {
          return toolError(error);
        }
      },
    }),
    defineTool({
      name: "specialist_reply",
      label: "Reply to specialist",
      description: "Answer a specialist question with a concise conclusion and evidence references.",
      promptSnippet: "Reply to a specialist question with evidence",
      parameters: Type.Object({
        message_id: Type.String({ description: "Message ID being answered." }),
        answer: Type.String({ description: "The answer or conclusion." }),
        evidence_refs: Type.Optional(Type.Array(Type.String())),
        affected_ids: Type.Optional(Type.Array(Type.String())),
        unresolved: Type.Optional(Type.Array(Type.String())),
      }),
      async execute(_toolCallId, params) {
        try {
          return toolResult(await broker.reply({
            messageId: params.message_id,
            senderRole: role,
            senderSessionId: getSessionId(),
            content: {
              summary: params.answer,
              answer: params.answer,
              evidence_refs: params.evidence_refs ?? [],
              affected_ids: params.affected_ids ?? [],
              unresolved: params.unresolved ?? [],
            },
          }));
        } catch (error) {
          return toolError(error);
        }
      },
    }),
    defineTool({
      name: "specialist_send",
      label: "Send specialist message",
      description: "Send a non-blocking evidence, challenge, proposal, or impact message through the orchestrator broker.",
      promptSnippet: "Send a durable specialist discussion message",
      parameters: Type.Object({
        target: Type.String({ description: "Recipient specialist role." }),
        kind: Type.String({ description: "Message kind, for example challenge, evidence, proposal, or impact-analysis." }),
        summary: Type.String({ description: "Concise product-relevant message." }),
        reply_to: Type.Optional(Type.String()),
        evidence_refs: Type.Optional(Type.Array(Type.String())),
        affected_ids: Type.Optional(Type.Array(Type.String())),
        unresolved: Type.Optional(Type.Array(Type.String())),
      }),
      async execute(_toolCallId, params) {
        try {
          return toolResult(await broker.send({
            kind: assertMessageKind(params.kind),
            senderRole: role,
            senderSessionId: getSessionId(),
            recipientRole: assertRole(params.target),
            replyTo: params.reply_to,
            content: {
              summary: params.summary,
              evidence_refs: params.evidence_refs ?? [],
              affected_ids: params.affected_ids ?? [],
              unresolved: params.unresolved ?? [],
            },
          }));
        } catch (error) {
          return toolError(error);
        }
      },
    }),
    defineTool({
      name: "specialist_resume",
      label: "Resume specialist discussion",
      description: "Check whether a previously pending specialist question has an answer.",
      parameters: Type.Object({ message_id: Type.String({ description: "Pending question message ID." }) }),
      async execute(_toolCallId, params) {
        try {
          return toolResult({ status: "answered", answer: broker.resume(params.message_id) ?? null });
        } catch (error) {
          return toolError(error);
        }
      },
    }),
    defineTool({
      name: "specialist_acknowledge",
      label: "Acknowledge specialist message",
      description: "Acknowledge receipt of a specialist message.",
      parameters: Type.Object({ message_id: Type.String({ description: "Message ID to acknowledge." }) }),
      async execute(_toolCallId, params) {
        try {
          return toolResult(await broker.acknowledge(params.message_id, role, getSessionId()));
        } catch (error) {
          return toolError(error);
        }
      },
    }),
  ];
}
