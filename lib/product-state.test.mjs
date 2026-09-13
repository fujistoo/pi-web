import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { createJiti } from "jiti";
import test from "node:test";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });
const { ProductFeatureStore } = await jiti.import("./product-state.ts");
const { default: productOrchestratorExtension } = await jiti.import("../.pi/extensions/product-orchestrator/index.ts");

async function tempProject() {
  return mkdtemp(join(tmpdir(), "pi-web-product-state-"));
}

test("creates a durable feature workspace and passes the initial design gate", async (t) => {
  const cwd = await tempProject();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new ProductFeatureStore(cwd, "TK-TEST-001");

  let snapshot = store.ensure();
  assert.deepEqual(await readdir(snapshot.directory), [
    "changes.yaml",
    "clarifications.yaml",
    "decisions.yaml",
    "deliberations",
    "design-map.yaml",
    "requirements.yaml",
    "runs",
    "scenarios.yaml",
    "specialist-results.yaml",
    "state.yaml",
  ]);

  store.writeRequirements({
    source: { type: "fixture", reference: "TK-TEST-001" },
    actors: ["Admin"],
    scope: "Feature management",
    acceptance_criteria: ["Admin can manage the feature"],
    requirements: { R1: { statement: "Admin can manage the feature", status: "active" } },
  });
  store.writeScenarios({
    scenarios: { SC1: { role: "Admin", expected: "edit" } },
  });
  store.writeDesignMap({
    reuse_map: { feature_form: { action: "reuse", existing_pattern: "ExistingForm" } },
  });
  for (const specialist of ["prd", "archaeology", "rbac"]) {
    store.recordSpecialistResult({ specialist, status: "resolved", summary: `${specialist} analysis complete.`, findings: [], evidence: [] });
  }

  snapshot = store.snapshot();
  assert.equal(snapshot.state.requirements_baseline, 1);
  assert.equal(snapshot.state.sources.fixture.reference, "TK-TEST-001");
  assert.equal(snapshot.state.specialist_status.prd, "complete");
  assert.equal(snapshot.state.specialist_status.rbac, "complete");
  assert.equal(snapshot.state.specialist_status.ux, "complete");
  assert.equal(store.readiness("before_design").ready, true);

  const state = load(await readFile(join(snapshot.directory, "state.yaml"), "utf8"));
  assert.equal(state.feature, "TK-TEST-001");
  assert.equal(state.lifecycle.phase, "discovery");
});

test("adds the specialist result document when resuming an older feature record", async (t) => {
  const cwd = await tempProject();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const directory = new ProductFeatureStore(cwd, "TK-TEST-001").ensure().directory;
  await unlink(join(directory, "specialist-results.yaml"));

  const snapshot = new ProductFeatureStore(cwd, "TK-TEST-001").snapshot();
  assert.deepEqual(snapshot.specialistResults.items, []);
});

test("persists structured specialist results and maps unresolved work to a blocker", async (t) => {
  const cwd = await tempProject();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new ProductFeatureStore(cwd, "TK-TEST-001");

  let snapshot = store.recordSpecialistResult({
    specialist: "prd",
    status: "resolved",
    summary: "The story contains two traceable requirements.",
    findings: [{ id: "R1", statement: "Users can review records." }],
    evidence: [{ source: "jira", reference: "TK-TEST-001" }],
    affected_ids: ["R1"],
    questions_for_agents: [],
  });
  assert.equal(snapshot.specialistResults.items.length, 1);
  assert.equal(snapshot.state.specialist_status.prd, "complete");

  snapshot = store.recordSpecialistResult({
    specialist: "rbac",
    status: "needs_deliberation",
    summary: "The role boundary is ambiguous.",
    findings: [],
    evidence: [],
    affected_ids: ["SC1"],
    questions_for_agents: [{ target: "prd", question: "Does AC2 override current scope?" }],
  });
  assert.equal(snapshot.state.specialist_status.rbac, "blocked");
  assert.equal(snapshot.specialistResults.items[1].id, "ANALYSIS-002");

  assert.throws(
    () => store.recordSpecialistResult({ specialist: "ux", status: "resolved", summary: "bad", evidence: "not-array" }),
    /evidence must be an array/,
  );
});

test("separates deliberation, clarification, decision, and change records", async (t) => {
  const cwd = await tempProject();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new ProductFeatureStore(cwd, "TK-TEST-001");

  const deliberation = store.recordDeliberation({
    topic: "Who can edit the feature?",
    raised_by: "product-designer",
    messages: [
      { from: "product-designer", type: "clarification", message: "Does the requirement override existing RBAC?" },
      { from: "rbac-analyst", type: "evidence", message: "Existing permission is scoped." },
    ],
    resolution: { status: "requires-product-decision" },
  });
  assert.equal(deliberation.id, "DISC-001");

  let snapshot = store.requestClarification({
    question: "Should scoped users edit approved records?",
    severity: "blocking",
    recommended_option: "Keep approved records read-only",
  });
  assert.deepEqual(snapshot.state.open_clarifications, ["CLAR-001"]);
  assert.equal(store.readiness("before_design").ready, false);
  assert.throws(
    () => store.recordDecision({ clarification_id: "CLAR-999", decision: "Ignore it." }),
    /Open clarification not found/,
  );

  snapshot = store.recordDecision({
    clarification_id: "CLAR-001",
    decision: "Keep approved records read-only.",
    affected: { requirements: ["R1"], scenarios: ["SC1"] },
  });
  assert.equal(snapshot.state.latest_decision, "DEC-001");
  assert.equal(snapshot.state.lifecycle.iteration, 2);
  assert.deepEqual(snapshot.state.open_clarifications, []);
  assert.equal(snapshot.clarifications.clarifications[0].status, "resolved");
  assert.equal(snapshot.decisions.items[0].status, "accepted");

  snapshot = store.recordChange({
    decision_id: "DEC-001",
    type: "requirement_change",
    summary: "Clarify approved-record editing in the canonical requirements.",
  });
  assert.equal(snapshot.changes.items[0].id, "CHG-001");
  assert.equal(snapshot.deliberations[0].id, "DISC-001");
  assert.equal(await readFile(join(snapshot.directory, "deliberations", "DISC-001.yaml"), "utf8").then((text) => text.includes("requires-product-decision")), true);
});

test("blocks Ready for Dev until every gate is explicitly reconciled", async (t) => {
  const cwd = await tempProject();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new ProductFeatureStore(cwd, "TK-TEST-001");

  store.writeRequirements({
    source: { type: "fixture", reference: "TK-TEST-001" },
    actors: ["Admin"],
    scope: "Feature management",
    acceptance_criteria: ["Admin can manage it"],
    requirements: { R1: { statement: "Manage it" } },
  });
  store.writeScenarios({ scenarios: { SC1: { role: "Admin", expected: "edit" } } });
  store.writeDesignMap({ reuse_map: { form: { action: "reuse" } }, annotations: ["CHANGE #1"] });
  for (const specialist of ["prd", "archaeology", "rbac", "ux", "qa"]) {
    store.recordSpecialistResult({ specialist, status: "resolved", summary: `${specialist} analysis complete.`, findings: [], evidence: [] });
  }

  let result = store.readiness("ready_for_dev");
  assert.equal(result.ready, false);
  assert.ok(result.missing.includes("Feedback has been converted into a product rule"));
  assert.ok(result.missing.includes("PRD is reconciled"));

  assert.throws(() => store.updateReadiness({ made_up: true }), /Unknown readiness field/);
  assert.throws(() => store.updateReadiness({ feedback_processed: "yes" }), /feedback_processed must be boolean/);
  store.updateReadiness({
    feedback_processed: true,
    material_deltas_annotated: true,
    prd_reconciled: true,
    figma_reconciled: true,
    contradictions_resolved: true,
  });
  result = store.readiness("ready_for_dev");
  assert.equal(result.ready, true);
});

test("runs the TK-TEST-001 design-analysis state flow and remains resumable", async (t) => {
  const cwd = await tempProject();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new ProductFeatureStore(cwd, "TK-TEST-001");

  store.ensure();
  store.writeRequirements({
    source: { type: "jira", reference: "TK-TEST-001" },
    actors: ["Admin", "Coordinator"],
    scope: "Record review and approval",
    acceptance_criteria: ["Authorized users can review records.", "Approved records are read-only."],
    requirements: {
      R1: { statement: "Authorized users can review records.", status: "active" },
      R2: { statement: "Coordinators are read-only after approval.", status: "ambiguous" },
    },
  });
  for (const result of [
    { specialist: "prd", summary: "Requirements are traceable." },
    { specialist: "archaeology", summary: "Existing record patterns can be reused." },
    { specialist: "rbac", summary: "Approval creates a read-only equivalence class." },
  ]) {
    store.recordSpecialistResult({ ...result, status: "resolved", findings: [], evidence: [] });
  }
  store.writeScenarios({ scenarios: { "SC-001": { role: "Admin", state: "Open", expected: "edit" } } });
  store.writeDesignMap({ reuse_map: { record_table: { action: "reuse" } }, annotations: [] });
  store.recordSpecialistResult({ specialist: "ux", status: "resolved", summary: "Reuse the existing record table.", findings: [], evidence: [] });
  store.recordSpecialistResult({ specialist: "qa", status: "resolved", summary: "Approval transition is covered.", findings: [], evidence: [] });

  store.requestClarification({
    question: "Should coordinators edit records after approval?",
    severity: "blocking",
    recommended_option: "Keep approved records read-only",
  });
  assert.equal(store.readiness("before_design").ready, false);
  store.recordDecision({
    clarification_id: "CLAR-001",
    decision: "Keep approved records read-only.",
    affected: { requirements: ["R2"], scenarios: ["SC-001"] },
  });
  store.recordChange({ decision_id: "DEC-001", type: "requirement_change", summary: "Clarified approval edit behavior." });
  store.updateReadiness({
    feedback_processed: true,
    material_deltas_annotated: true,
    prd_reconciled: true,
    figma_reconciled: true,
    contradictions_resolved: true,
  });

  const final = store.readiness("ready_for_dev");
  assert.equal(final.ready, true);
  assert.equal(store.snapshot().specialistResults.items.length, 5);
});

test("the product_state tool writes under the session cwd", async (t) => {
  const cwd = await tempProject();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const tools = [];
  productOrchestratorExtension({ registerTool: (tool) => tools.push(tool) });
  const tool = tools.find((candidate) => candidate.name === "product_state");
  assert.ok(tool);
  const result = await tool.execute("call-1", { action: "init", feature: "TK-TEST-001" }, undefined, undefined, { cwd });
  assert.match(result.content[0].text, /TK-TEST-001/);
  const recorded = await tool.execute("call-2", {
    action: "record_specialist_result",
    feature: "TK-TEST-001",
    data: { specialist: "prd", status: "resolved", summary: "Requirements are traceable.", findings: [], evidence: [] },
  }, undefined, undefined, { cwd });
  assert.match(recorded.content[0].text, /specialistResults/);
  assert.equal((await readdir(join(cwd, ".product", "features"))).length, 1);
});

test("rejects feature ids that could escape the project workspace", async () => {
  const cwd = await tempProject();
  assert.throws(() => new ProductFeatureStore(cwd, "../outside"), /Feature id/);
  await rm(cwd, { recursive: true, force: true });
});
