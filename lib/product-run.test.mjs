import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import test from "node:test";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });
const { ProductFeatureStore } = await jiti.import("./product-state.ts");
const { ProductRunCoordinator } = await jiti.import("./product-run.ts");

const outcome = (summary, requirements_baseline = null) => ({
  status: "resolved",
  summary,
  requirements_baseline,
});

test("coordinates dependency-aware tasks and joins completed work", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-product-run-"));
  try {
    const store = new ProductFeatureStore(cwd, "TK-RUN-001");
    store.ensure();
    const run = ProductRunCoordinator.start(store, { id: "RUN-001", objective: "Coordinate specialists" });
    const coordinator = new ProductRunCoordinator({ store, runId: run.id });
    await coordinator.addTask({ id: "TASK-001", role: "qa", description: "Check behavior" });
    await coordinator.addTask({ id: "TASK-002", role: "rbac", description: "Check permissions", dependencies: ["TASK-001"] });
    await assert.rejects(() => coordinator.startTask("TASK-002"), /waiting on/);
    await coordinator.startTask("TASK-001");
    const evidence = await coordinator.addEvidence({ source: "fixture", source_id: "req-1", summary: "Requirement evidence", source_version: 1 });
    await coordinator.completeTask("TASK-001", { ...outcome("Behavior is clear"), evidence: [evidence.id], affected_ids: ["REQ-1"] });
    assert.deepEqual(coordinator.join().ready_task_ids, ["TASK-002"]);
    await coordinator.startTask("TASK-002");
    await coordinator.completeTask("TASK-002", outcome("Permission is clear"));
    const joined = coordinator.join();
    assert.equal(joined.can_synthesize, true);
    assert.deepEqual(joined.completed_task_ids, ["TASK-001", "TASK-002"]);
    assert.equal(store.getRun(run.id).phase, "synthesis");
    await coordinator.markEvidenceStale([evidence.id], "Source version changed");
    assert.deepEqual(coordinator.join().stale_task_ids, ["TASK-001"]);
    assert.deepEqual(await coordinator.invalidateByAffectedIds(["REQ-1"], "Accepted decision changed the requirement"), [store.getRun(run.id).tasks[0]]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("updates an automatically completed task with the orchestrator's structured outcome", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-product-run-"));
  try {
    const store = new ProductFeatureStore(cwd, "TK-RUN-003");
    store.ensure();
    const run = ProductRunCoordinator.start(store, { id: "RUN-001", objective: "Merge specialist evidence" });
    const coordinator = new ProductRunCoordinator({ store, runId: run.id });
    await coordinator.addTask({ id: "TASK-001", role: "qa" });
    await coordinator.startTask("TASK-001");
    await coordinator.completeTask("TASK-001", { status: "needs_deliberation", summary: "Specialist found an ambiguity" });
    const updated = await coordinator.completeTask("TASK-001", {
      status: "resolved",
      summary: "The ambiguity is resolved",
      evidence: ["EVID-001"],
      affected_ids: ["REQ-001"],
      questions_for_agents: [],
    });
    assert.equal(updated.status, "completed");
    assert.equal(updated.outcome.summary, "The ambiguity is resolved");
    assert.deepEqual(updated.outcome.evidence, ["EVID-001"]);
    assert.equal(store.getRun(run.id).status, "synthesizing");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("marks baseline-mismatched outcomes stale and supports bounded retry/resume", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-product-run-"));
  try {
    const store = new ProductFeatureStore(cwd, "TK-RUN-002");
    store.ensure();
    store.writeRequirements({ baseline: 1, requirements: { REQ: "baseline" } });
    const run = ProductRunCoordinator.start(store, { id: "RUN-001", objective: "Handle stale specialist work" });
    const coordinator = new ProductRunCoordinator({ store, runId: run.id });
    await coordinator.addTask({ id: "TASK-001", role: "qa", max_attempts: 2 });
    await coordinator.startTask("TASK-001");
    const stale = await coordinator.completeTask("TASK-001", outcome("Old result", 0));
    assert.equal(stale.status, "stale");
    assert.deepEqual(coordinator.join().stale_task_ids, ["TASK-001"]);
    await coordinator.retryTask("TASK-001", "Requirement changed");
    await coordinator.startTask("TASK-001");
    const runAfterStart = store.getRun(run.id);
    assert.equal(runAfterStart.tasks[0].attempt, 2);
    const resumed = await coordinator.resume();
    assert.deepEqual(resumed.ready_task_ids, ["TASK-001"]);
    await assert.rejects(() => coordinator.startTask("TASK-001"), /exhausted/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
