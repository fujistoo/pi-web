import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { createJiti } from "jiti";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const specialistAgentDir = await mkdtemp(join(tmpdir(), "pi-web-specialists-global-"));
process.env.PI_CODING_AGENT_DIR = specialistAgentDir;

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });
const { resolveSubagentProfile } = await jiti.import("./subagents.ts");
const { ProductFeatureStore } = await jiti.import("./product-state.ts");

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(specialistAgentDir, { recursive: true, force: true });
});

// Must match ProductAgentRole in lib/product-messaging.ts minus "orchestrator": the profile name is
// what the Agent tool resolves and product.role is what the run/broker validates, so a rename that
// breaks the pairing must fail here rather than silently fall back to general-purpose.
const PRODUCT_SPECIALIST_ROLES = ["prd", "archaeology", "rbac", "ux", "qa"];
// assertRole() in lib/product-messaging.ts.
const VALID_BROKER_TARGETS = [...PRODUCT_SPECIALIST_ROLES, "orchestrator"];
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const WRITE_CAPABLE_TOOLS = ["bash", "edit", "write", "powershell"];

async function profileSource(role) {
  return readFile(join(projectRoot, ".pi", "agents", `${role}.md`), "utf8");
}

function exampleBlock(source, role) {
  const fence = source.match(/```yaml\n([\s\S]*?)\n```/);
  assert.ok(fence, `${role} profile has no fenced yaml example block`);
  return load(fence[1]);
}

test("every product specialist role resolves to an enabled project profile", () => {
  for (const role of PRODUCT_SPECIALIST_ROLES) {
    const profile = resolveSubagentProfile(projectRoot, role);
    assert.ok(profile, `no subagent profile resolves for product role "${role}"`);
    assert.equal(profile.enabled, true, `${role} profile is disabled`);
    assert.equal(profile.scope, "project", `${role} profile must come from .pi/agents, not ${profile.scope}`);
    assert.match(profile.description, /\S/, `${role} profile needs a description`);
    assert.ok(profile.systemPrompt.trim().length > 200, `${role} profile system prompt is too thin to be self-contained`);
  }
});

test("product specialists cannot write files or mutate external systems", () => {
  for (const role of PRODUCT_SPECIALIST_ROLES) {
    const profile = resolveSubagentProfile(projectRoot, role);
    assert.deepEqual([...profile.tools].sort(), [...READ_ONLY_TOOLS].sort(), `${role} tools must be exactly read-only`);
    for (const tool of WRITE_CAPABLE_TOOLS) {
      assert.ok(!profile.tools.includes(tool), `${role} must not hold ${tool}`);
    }
    assert.equal(profile.loadExtensions, false, `${role} must not load extensions that could register product_state`);
  }
});

test("product specialists stay ephemeral and cannot spawn children", () => {
  for (const role of PRODUCT_SPECIALIST_ROLES) {
    const profile = resolveSubagentProfile(projectRoot, role);
    assert.equal(profile.loadSkills, false, `${role} must not pull in unrelated skill context`);
    assert.equal(profile.inheritContext, false, `${role} receives a self-contained task from the orchestrator`);
    assert.equal(profile.promptMode, "append", `${role} keeps the default pi tool guidance`);
    assert.ok(!profile.tools.includes("Agent"), `${role} must not be able to delegate further`);
  }
});

// A live prd run emitted `to: supervisor`, which assertRole() rejects: the message would throw instead
// of escalating. The example block is what the model copies, so it must only use routable targets.
test("specialist example blocks only address routable broker targets", async () => {
  for (const role of PRODUCT_SPECIALIST_ROLES) {
    const source = await profileSource(role);
    for (const [, target] of source.matchAll(/^\s*to:\s*(\S+)\s*$/gm)) {
      const name = target.replace(/['"]/g, "");
      assert.ok(
        VALID_BROKER_TARGETS.includes(name),
        `${role} example addresses "${name}", which assertRole() rejects`,
      );
    }
    assert.doesNotMatch(source, /to:\s*supervisor/, `${role} must not invent a "supervisor" target`);
  }
});

test("specialist example blocks use the canonical clarification key casing", async () => {
  for (const role of PRODUCT_SPECIALIST_ROLES) {
    const source = await profileSource(role);
    assert.match(source, /^\s*affectedRequirements:/m, `${role} must emit camelCase affectedRequirements`);
    assert.doesNotMatch(source, /affected_requirements/, `${role} must not emit snake_case affected_requirements`);
  }
});

// The profile output is persisted verbatim by record_specialist_result / request_clarification, and
// both spread the payload without validating unknown keys. A miscased or renamed key therefore persists
// silently and is read by nothing, so each example block is replayed through the real store here.
test("every specialist example block is accepted verbatim by the durable store", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-specialist-contract-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  for (const role of PRODUCT_SPECIALIST_ROLES) {
    const store = new ProductFeatureStore(cwd, `TK-${role.toUpperCase()}`);
    store.ensure();
    const block = exampleBlock(await profileSource(role), role);

    assert.equal(block.specialist, role, `${role} example must declare specialist: ${role}`);

    // recordSpecialistResult() requires these keys; a missing one is a hard error at persist time.
    for (const key of ["summary", "findings", "evidence", "affected_ids", "questions_for_agents"]) {
      assert.ok(key in block, `${role} example is missing "${key}" required by record_specialist_result`);
    }

    // The block documents the status enum as "resolved | needs_deliberation | blocked"; substitute a
    // concrete value so the replay exercises the store rather than the placeholder.
    const [firstStatus] = String(block.status).split("|").map((value) => value.trim());
    block.status = firstStatus;
    assert.ok(
      ["resolved", "needs_deliberation", "blocked"].includes(block.status),
      `${role} example documents a status the store rejects: ${block.status}`,
    );

    const snapshot = store.recordSpecialistResult(block);
    assert.equal(snapshot.state.specialist_status[role], block.status === "resolved" ? "complete" : "blocked");
    const results = snapshot.specialistResults.items ?? [];
    assert.equal(results.length, 1, `${role} specialist result did not persist under specialist-results.yaml`);

    if (block.clarification_request) {
      const withClarification = store.requestClarification(block.clarification_request);
      assert.equal(
        withClarification.state.open_clarifications.length,
        1,
        `${role} clarification did not open`,
      );
      const open = withClarification.clarifications.clarifications[0];
      assert.ok(
        "affectedRequirements" in open,
        `${role} clarification lost affectedRequirements to a key-casing mismatch: ${JSON.stringify(Object.keys(open))}`,
      );
    }
  }
});
