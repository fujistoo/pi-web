import {
  ProductFeatureStore,
  type ProductExternalWriteStatus,
} from "./product-state";

export interface ProductVerificationInput {
  status: "passed" | "failed" | "partial";
  summary: string;
  expected?: unknown;
  observed?: unknown;
  evidence_refs?: string[];
}

export class ProductReconciliationCoordinator {
  readonly store: ProductFeatureStore;

  constructor(store: ProductFeatureStore) {
    this.store = store;
    this.store.ensure();
  }

  recordFeedback(data: Record<string, unknown>) {
    return this.store.recordFeedback(data);
  }

  proposeExternalWrite(data: Record<string, unknown>) {
    return this.store.recordExternalWrite(data);
  }

  approveExternalWrite(id: string, approval: { decision_id: string; approved_by?: string }) {
    if (!approval.decision_id?.trim()) throw new Error("External write approval requires decision_id");
    return this.store.updateExternalWrite(id, {
      status: "approved",
      approval: { ...approval, approved_at: new Date().toISOString() },
    });
  }

  beginExternalWrite(id: string) {
    const current = this.requireWrite(id);
    if (current.status !== "approved") throw new Error(`External write must be approved before execution: ${id}`);
    return this.store.updateExternalWrite(id, { status: "pending", started_at: new Date().toISOString() });
  }

  recordExternalReceipt(id: string, receipt: Record<string, unknown>) {
    const current = this.requireWrite(id);
    if (current.status !== "pending") throw new Error(`External write is not pending: ${id}`);
    if (Object.keys(receipt).length === 0) throw new Error("External write receipt is required");
    return this.store.updateExternalWrite(id, { status: "written", receipt, written_at: new Date().toISOString() });
  }

  verifyExternalWrite(id: string, input: ProductVerificationInput) {
    const current = this.requireWrite(id);
    if (current.status !== "written") throw new Error(`External write must be written before verification: ${id}`);
    const verification = this.store.recordVerification({
      external_write_id: id,
      ...input,
      recorded_at: new Date().toISOString(),
    });
    const status: ProductExternalWriteStatus = input.status === "passed"
      ? "verified"
      : input.status === "partial"
        ? "partially_reconciled"
        : "failed";
    const write = this.store.updateExternalWrite(id, { status, verification_id: verification.id });
    return { write, verification };
  }

  reconcileExternalWrite(id: string) {
    const current = this.requireWrite(id);
    if (current.status !== "verified") throw new Error(`Only a verified external write can be reconciled: ${id}`);
    return this.store.updateExternalWrite(id, { status: "reconciled", reconciled_at: new Date().toISOString() });
  }

  private requireWrite(id: string): Record<string, unknown> & { status: ProductExternalWriteStatus } {
    const write = this.store.getExternalWrite(id);
    if (!write) throw new Error(`External write not found: ${id}`);
    return write as Record<string, unknown> & { status: ProductExternalWriteStatus };
  }
}
