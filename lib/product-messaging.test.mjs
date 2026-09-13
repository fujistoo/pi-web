import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import test from "node:test";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });
const { ProductFeatureStore } = await jiti.import("./product-state.ts");
const { ProductDeliberationBroker } = await jiti.import("./product-messaging.ts");

function content(summary) {
  return { summary, evidence_refs: [], affected_ids: [], unresolved: [] };
}

test("persists brokered questions, answers, delivery, and idempotent retries", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-product-broker-"));
  try {
    const store = new ProductFeatureStore(cwd, "TK-TEST-001");
    store.ensure();
    store.startRun({ id: "RUN-001", objective: "Validate specialist communication" });
    const delivered = [];
    const broker = new ProductDeliberationBroker({
      cwd,
      feature: "TK-TEST-001",
      runId: "RUN-001",
      transport: { deliver: async (input) => delivered.push(input) },
    });
    await broker.registerParticipant({ role: "qa", sessionId: "qa-1" });
    await broker.registerParticipant({ role: "rbac", sessionId: "rbac-1" });

    const question = await broker.ask({
      senderRole: "qa",
      senderSessionId: "qa-1",
      recipientRole: "rbac",
      content: { ...content("Can this action be used by a delegated approver?"), question: "Can this action be used by a delegated approver?" },
    }, { waitMs: 0 });
    assert.equal(question.status, "delivered");
    assert.equal(question.duplicate, false);
    assert.equal(delivered.length, 1);

    const answer = await broker.reply({
      messageId: question.message_id,
      senderRole: "rbac",
      senderSessionId: "rbac-1",
      content: { ...content("No. The delegated approver lacks the required permission."), answer: "No. The delegated approver lacks the required permission." },
    });
    assert.equal(answer.status, "delivered");
    assert.equal(broker.resume(question.message_id)?.content.answer, "No. The delegated approver lacks the required permission.");

    const duplicate = await broker.send({
      messageId: question.message_id,
      discussionId: question.discussion_id,
      kind: "question",
      senderRole: "qa",
      senderSessionId: "qa-1",
      recipientRole: "rbac",
      content: { ...content("Can this action be used by a delegated approver?"), question: "Can this action be used by a delegated approver?" },
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(store.getDiscussion(question.discussion_id).messages.length, 2);

    const discussion = store.getDiscussion(question.discussion_id);
    assert.equal(discussion.messages[0].delivery.status, "answered");
    assert.equal(discussion.messages[1].reply_to, question.message_id);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("queues an addressed message until the recipient registers", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-product-broker-"));
  try {
    const store = new ProductFeatureStore(cwd, "TK-TEST-002");
    store.ensure();
    store.startRun({ id: "RUN-001", objective: "Queue a specialist question" });
    const delivered = [];
    const broker = new ProductDeliberationBroker({
      cwd,
      feature: "TK-TEST-002",
      runId: "RUN-001",
      transport: { deliver: async (input) => delivered.push(input) },
    });
    await broker.registerParticipant({ role: "qa", sessionId: "qa-1" });
    const pending = await broker.ask({
      senderRole: "qa",
      senderSessionId: "qa-1",
      recipientRole: "rbac",
      content: content("What permission gates this path?"),
    }, { waitMs: 0 });
    assert.equal(pending.status, "queued");
    assert.equal(delivered.length, 0);

    await broker.registerParticipant({ role: "rbac", sessionId: "rbac-1" });
    assert.equal(delivered.length, 1);
    const message = broker.getDiscussion(pending.discussion_id).messages[0];
    assert.equal(message.recipient.session_id, "rbac-1");
    assert.equal(message.delivery.status, "delivered");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("wakes an ask from durable replies created by another broker instance", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-product-broker-"));
  try {
    const store = new ProductFeatureStore(cwd, "TK-TEST-004");
    store.ensure();
    store.startRun({ id: "RUN-001", objective: "Wake across broker instances" });
    const first = new ProductDeliberationBroker({ cwd, feature: "TK-TEST-004", runId: "RUN-001" });
    const second = new ProductDeliberationBroker({ cwd, feature: "TK-TEST-004", runId: "RUN-001" });
    await first.registerParticipant({ role: "qa", sessionId: "qa-1" });
    await first.registerParticipant({ role: "rbac", sessionId: "rbac-1" });
    const pending = first.ask({ senderRole: "qa", senderSessionId: "qa-1", recipientRole: "rbac", content: content("Is this allowed?") }, { waitMs: 1000 });
    setTimeout(() => void second.reply({
      messageId: first.getDiscussion("DISC-001").messages[0].message_id,
      senderRole: "rbac",
      senderSessionId: "rbac-1",
      content: { ...content("Yes, for this scoped role."), answer: "Yes, for this scoped role." },
    }), 50);
    const result = await pending;
    assert.equal(result.answer.content.answer, "Yes, for this scoped role.");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("rejects messages from unregistered or role-mismatched sessions", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-product-broker-"));
  try {
    const store = new ProductFeatureStore(cwd, "TK-TEST-005");
    store.ensure();
    store.startRun({ id: "RUN-001", objective: "Authorize specialist messages" });
    const broker = new ProductDeliberationBroker({ cwd, feature: "TK-TEST-005", runId: "RUN-001" });
    await broker.registerParticipant({ role: "qa", sessionId: "qa-1" });
    await broker.registerParticipant({ role: "rbac", sessionId: "rbac-1" });
    await assert.rejects(() => broker.send({
      kind: "question",
      senderRole: "qa",
      senderSessionId: "unknown",
      recipientRole: "rbac",
      content: content("Not authorized"),
    }), /not registered/);
    await assert.rejects(() => broker.send({
      kind: "question",
      senderRole: "rbac",
      senderSessionId: "qa-1",
      recipientRole: "qa",
      content: content("Wrong role"),
    }), /not the rbac participant/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("serializes concurrent appends to one discussion", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-product-broker-"));
  try {
    const store = new ProductFeatureStore(cwd, "TK-TEST-003");
    store.ensure();
    store.startRun({ id: "RUN-001", objective: "Keep concurrent specialist messages durable" });
    const broker = new ProductDeliberationBroker({ cwd, feature: "TK-TEST-003", runId: "RUN-001" });
    await broker.registerParticipant({ role: "rbac", sessionId: "rbac-1" });
    await Promise.all(Array.from({ length: 10 }, (_, index) => broker.registerParticipant({ role: "qa", sessionId: `qa-${index}` })));
    const discussion = store.createDiscussion({ run_id: "RUN-001", id: "DISC-001", topic: "Concurrent evidence", max_rounds: 20 });
    await Promise.all(Array.from({ length: 10 }, (_, index) => broker.send({
      discussionId: discussion.id,
      kind: "evidence",
      senderRole: "qa",
      senderSessionId: `qa-${index}`,
      recipientRole: "rbac",
      content: content(`Evidence ${index}`),
    })));
    assert.equal(store.getDiscussion(discussion.id).messages.length, 10);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
