import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import test from "node:test";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });
const { ProductFeatureStore } = await jiti.import("./product-state.ts");
const { ProductReconciliationCoordinator } = await jiti.import("./product-reconciliation.ts");

test("records feedback and enforces approval, receipt, verification, and reconciliation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-product-reconciliation-"));
  try {
    const store = new ProductFeatureStore(cwd, "TK-RECON-001");
    store.ensure();
    const reconciliation = new ProductReconciliationCoordinator(store);
    const feedback = reconciliation.recordFeedback({
      source: "figma",
      source_id: "comment-42",
      summary: "Category Coordinators must not edit after approval.",
      source_version: "84",
      affected_ids: ["REQ-004", "SC-002"],
    });
    assert.equal(feedback.id, "FB-001");
    assert.equal(reconciliation.recordFeedback({ source: "figma", source_id: "comment-42", summary: "duplicate" }).id, "FB-001");

    const write = reconciliation.proposeExternalWrite({
      source_id: "DEC-009",
      target: "jira",
      operation: "update_issue_description",
      idempotency_key: "TK-RECON-001:DEC-009:jira-description",
      precondition: { issue_revision: 12 },
      proposed_diff: "Clarify approval behavior.",
    });
    assert.throws(() => reconciliation.beginExternalWrite(write.id), /must be approved/);
    assert.throws(() => reconciliation.approveExternalWrite(write.id, { decision_id: "" }), /requires decision_id/);
    reconciliation.approveExternalWrite(write.id, { decision_id: "DEC-009", approved_by: "po" });
    reconciliation.beginExternalWrite(write.id);
    reconciliation.recordExternalReceipt(write.id, { issue_revision: 13, operation_id: "jira-op-1" });
    const verified = reconciliation.verifyExternalWrite(write.id, {
      status: "passed",
      summary: "Refetched Jira and matched the proposed description.",
      expected: { issue_revision: 13 },
      observed: { issue_revision: 13 },
      evidence_refs: ["jira:TK-RECON-001@13"],
    });
    assert.equal(verified.write.status, "verified");
    assert.equal(reconciliation.reconcileExternalWrite(write.id).status, "reconciled");
    assert.deepEqual(await readdir(join(cwd, ".product", "features", "TK-RECON-001", "external-writes")), ["WRITE-001.yaml"]);
    assert.deepEqual(store.snapshot().verifications.map((item) => item.id), ["VERIFY-001"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("keeps partial verification visibly partial", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-product-reconciliation-"));
  try {
    const store = new ProductFeatureStore(cwd, "TK-RECON-002");
    const reconciliation = new ProductReconciliationCoordinator(store);
    const write = reconciliation.proposeExternalWrite({
      source_id: "CHG-001",
      target: "figma",
      operation: "add_annotation",
      idempotency_key: "TK-RECON-002:CHG-001:figma-annotation",
      precondition: { file_version: 10 },
    });
    reconciliation.approveExternalWrite(write.id, { decision_id: "DEC-001" });
    reconciliation.beginExternalWrite(write.id);
    reconciliation.recordExternalReceipt(write.id, { file_version: 11, node_id: "1:2" });
    const result = reconciliation.verifyExternalWrite(write.id, { status: "partial", summary: "Annotation write succeeded but refetch is incomplete." });
    assert.equal(result.write.status, "partially_reconciled");
    assert.throws(() => reconciliation.reconcileExternalWrite(write.id), /Only a verified/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
