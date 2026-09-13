import { dump, load } from "js-yaml";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file";

export const PRODUCT_FEATURES_DIR = ".product/features";

const FEATURE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RECORD_ID_PATTERN = /^[A-Z]+-[0-9]{3,}$/;
const DELIBERATION_DIR = "deliberations";
const RUN_DIR = "runs";
const FEEDBACK_DIR = "feedback";
const EXTERNAL_WRITE_DIR = "external-writes";
const VERIFICATION_DIR = "verification";

export type ProductRunStatus = "planned" | "running" | "waiting" | "synthesizing" | "clarification" | "completed" | "blocked" | "failed";
export type ProductRunPhase = "planning" | "evidence" | "fanout" | "deliberating" | "synthesis" | "clarification" | "writeback" | "verification" | "completed";
export type ProductDiscussionStatus = "open" | "awaiting_response" | "contested" | "resolved" | "escalated" | "blocked";
export type ProductExternalWriteStatus = "proposed" | "approved" | "pending" | "written" | "verified" | "reconciled" | "partially_reconciled" | "failed";

export interface ProductRunRecord {
  version: number;
  feature: string;
  id: string;
  objective: string;
  status: ProductRunStatus;
  phase: ProductRunPhase;
  requirements_baseline: number | null;
  participants: Record<string, unknown>[];
  tasks: Record<string, unknown>[];
  discussions: string[];
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export interface ProductDiscussionRecord {
  version: number;
  feature: string;
  id: string;
  run_id: string;
  topic: string;
  status: ProductDiscussionStatus;
  messages: Record<string, unknown>[];
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export type ProductPhase =
  | "discovery"
  | "clarification"
  | "design_iteration"
  | "feedback_review"
  | "ready_for_dev";

export const SPECIALIST_NAMES = ["prd", "archaeology", "rbac", "ux", "qa"] as const;
export type SpecialistName = (typeof SPECIALIST_NAMES)[number];
export type SpecialistStatus = "pending" | "running" | "complete" | "blocked";
export type SpecialistResultStatus = "resolved" | "needs_deliberation" | "blocked";

export interface ProductReadiness {
  feedback_processed: boolean;
  material_deltas_annotated: boolean;
  prd_reconciled: boolean;
  figma_reconciled: boolean;
  contradictions_resolved: boolean;
}

export interface ProductFeatureState {
  feature: string;
  lifecycle: { phase: ProductPhase; iteration: number };
  sources: Record<string, unknown>;
  requirements_baseline: number | null;
  open_clarifications: string[];
  latest_decision: string | null;
  specialist_status: Record<string, SpecialistStatus>;
  readiness: ProductReadiness;
  updated_at: string;
}

export interface ProductFeatureSnapshot {
  directory: string;
  state: ProductFeatureState;
  requirements: Record<string, unknown>;
  scenarios: Record<string, unknown>;
  designMap: Record<string, unknown>;
  decisions: Record<string, unknown>;
  changes: Record<string, unknown>;
  clarifications: Record<string, unknown>;
  specialistResults: Record<string, unknown>;
  deliberations: Record<string, unknown>[];
  runs: Record<string, unknown>[];
  feedback: Record<string, unknown>[];
  externalWrites: Record<string, unknown>[];
  verifications: Record<string, unknown>[];
}

export interface ReadinessCheck {
  id: string;
  label: string;
  passed: boolean;
  blocking: boolean;
  detail: string;
}

export interface ReadinessResult {
  feature: string;
  gate: "before_design" | "before_feedback" | "ready_for_dev";
  ready: boolean;
  checks: ReadinessCheck[];
  missing: string[];
}

type ProductStatePatch = {
  lifecycle?: Partial<ProductFeatureState["lifecycle"]>;
  sources?: Record<string, unknown>;
  requirements_baseline?: number | null;
  open_clarifications?: string[];
  latest_decision?: string | null;
  specialist_status?: Record<string, SpecialistStatus>;
  readiness?: Partial<ProductReadiness>;
};

const DEFAULT_SPECIALIST_STATUS: Record<string, SpecialistStatus> = {
  prd: "pending",
  archaeology: "pending",
  rbac: "pending",
  ux: "pending",
  qa: "pending",
};

const DEFAULT_READINESS: ProductReadiness = {
  feedback_processed: false,
  material_deltas_annotated: false,
  prd_reconciled: false,
  figma_reconciled: false,
  contradictions_resolved: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasContent(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return typeof value === "string" ? value.trim().length > 0 : value !== undefined && value !== null;
}

function assertFeatureId(feature: string): string {
  const value = feature.trim();
  if (!FEATURE_ID_PATTERN.test(value)) {
    throw new Error("Feature id may contain only letters, numbers, dots, underscores, and hyphens");
  }
  return value;
}

function assertRecordId(id: string, prefix: string): string {
  const value = id.trim();
  if (!RECORD_ID_PATTERN.test(value) || !value.startsWith(`${prefix}-`)) {
    throw new Error(`${prefix} id must look like ${prefix}-001`);
  }
  return value;
}

function assertWithinCwd(cwd: string, path: string): void {
  const root = realpathSync(resolve(cwd));
  let existing = resolve(path);
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const target = realpathSync(existing);
  const child = relative(root, target);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("Product feature workspace must remain inside the project cwd");
  }
}

function now(): string {
  return new Date().toISOString();
}

function writeYaml(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(path, dump(value, { lineWidth: 120, noRefs: true, sortKeys: false }));
}

function readYaml(path: string, label: string): Record<string, unknown> {
  if (!existsSync(path)) throw new Error(`${label} does not exist`);
  let value: unknown;
  try {
    value = load(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value)) throw new Error(`${label} must contain a YAML object`);
  return value;
}

function freshState(feature: string): ProductFeatureState {
  return {
    feature,
    lifecycle: { phase: "discovery", iteration: 1 },
    sources: {},
    requirements_baseline: null,
    open_clarifications: [],
    latest_decision: null,
    specialist_status: { ...DEFAULT_SPECIALIST_STATUS },
    readiness: { ...DEFAULT_READINESS },
    updated_at: now(),
  };
}

function freshRequirements(feature: string): Record<string, unknown> {
  return { version: 1, feature, baseline: null, actors: [], requirements: {} };
}

function freshScenarios(feature: string): Record<string, unknown> {
  return { version: 1, feature, scenarios: {} };
}

function freshDesignMap(feature: string): Record<string, unknown> {
  return { version: 1, feature, reuse_map: {}, annotations: [] };
}

function freshListDocument(feature: string): Record<string, unknown> {
  return { version: 1, feature, items: [] };
}

function freshClarifications(feature: string): Record<string, unknown> {
  return { version: 1, feature, clarifications: [] };
}

function freshSpecialistResults(feature: string): Record<string, unknown> {
  return { version: 1, feature, items: [] };
}

function listItems(document: Record<string, unknown>, field: string): Record<string, unknown>[] {
  const value = document[field];
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

function nextRecordId(prefix: string, items: readonly Record<string, unknown>[], directory?: string): string {
  let next = 1;
  for (const item of items) {
    if (typeof item.id !== "string") continue;
    const match = item.id.match(new RegExp(`^${prefix}-(\\d+)$`));
    if (match) next = Math.max(next, Number(match[1]) + 1);
  }
  if (directory && existsSync(directory)) {
    for (const file of readdirSync(directory)) {
      const match = file.match(new RegExp(`^${prefix}-(\\d+)\\.yaml$`));
      if (match) next = Math.max(next, Number(match[1]) + 1);
    }
  }
  return `${prefix}-${String(next).padStart(3, "0")}`;
}

function readDirectoryRecords(directory: string): Record<string, unknown>[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((file) => file.endsWith(".yaml"))
    .sort()
    .map((file) => readYaml(join(directory, file), file));
}

function withFeature(feature: string, data: Record<string, unknown>): Record<string, unknown> {
  return { ...data, version: 1, feature };
}

export class ProductFeatureStore {
  readonly feature: string;
  readonly directory: string;

  constructor(cwd: string, feature: string) {
    this.feature = assertFeatureId(feature);
    this.directory = resolve(cwd, PRODUCT_FEATURES_DIR, this.feature);
    assertWithinCwd(cwd, this.directory);
  }

  private file(name: string): string {
    return join(this.directory, name);
  }

  private state(): ProductFeatureState {
    return readYaml(this.file("state.yaml"), "state.yaml") as unknown as ProductFeatureState;
  }

  private writeState(patch: ProductStatePatch): ProductFeatureState {
    const current = this.state();
    const next: ProductFeatureState = {
      ...current,
      ...patch,
      lifecycle: { ...current.lifecycle, ...patch.lifecycle },
      sources: { ...current.sources, ...(patch.sources ?? {}) },
      specialist_status: { ...current.specialist_status, ...(patch.specialist_status ?? {}) },
      readiness: { ...current.readiness, ...(patch.readiness ?? {}) },
      updated_at: now(),
    };
    writeYaml(this.file("state.yaml"), next);
    return next;
  }

  ensure(): ProductFeatureSnapshot {
    mkdirSync(join(this.directory, DELIBERATION_DIR), { recursive: true });
    mkdirSync(join(this.directory, RUN_DIR), { recursive: true });
    const files: Array<[string, Record<string, unknown>]> = [
      ["state.yaml", freshState(this.feature) as unknown as Record<string, unknown>],
      ["requirements.yaml", freshRequirements(this.feature)],
      ["scenarios.yaml", freshScenarios(this.feature)],
      ["design-map.yaml", freshDesignMap(this.feature)],
      ["decisions.yaml", freshListDocument(this.feature)],
      ["changes.yaml", freshListDocument(this.feature)],
      ["clarifications.yaml", freshClarifications(this.feature)],
      ["specialist-results.yaml", freshSpecialistResults(this.feature)],
    ];
    for (const [name, value] of files) if (!existsSync(this.file(name))) writeYaml(this.file(name), value);
    return this.snapshot();
  }

  snapshot(): ProductFeatureSnapshot {
    this.ensureDirectory();
    const deliberations = readDirectoryRecords(join(this.directory, DELIBERATION_DIR));
    const runs = readDirectoryRecords(join(this.directory, RUN_DIR));
    const feedback = readDirectoryRecords(join(this.directory, FEEDBACK_DIR));
    const externalWrites = readDirectoryRecords(join(this.directory, EXTERNAL_WRITE_DIR));
    const verifications = readDirectoryRecords(join(this.directory, VERIFICATION_DIR));
    return {
      directory: this.directory,
      state: this.state(),
      requirements: readYaml(this.file("requirements.yaml"), "requirements.yaml"),
      scenarios: readYaml(this.file("scenarios.yaml"), "scenarios.yaml"),
      designMap: readYaml(this.file("design-map.yaml"), "design-map.yaml"),
      decisions: readYaml(this.file("decisions.yaml"), "decisions.yaml"),
      changes: readYaml(this.file("changes.yaml"), "changes.yaml"),
      clarifications: readYaml(this.file("clarifications.yaml"), "clarifications.yaml"),
      specialistResults: readYaml(this.file("specialist-results.yaml"), "specialist-results.yaml"),
      deliberations,
      runs,
      feedback,
      externalWrites,
      verifications,
    };
  }


  private ensureDirectory(): void {
    if (!existsSync(this.file("state.yaml"))) {
      this.ensure();
      return;
    }
    mkdirSync(join(this.directory, DELIBERATION_DIR), { recursive: true });
    mkdirSync(join(this.directory, RUN_DIR), { recursive: true });
    // Add new audit documents lazily so existing feature records remain resumable.
    if (!existsSync(this.file("specialist-results.yaml"))) {
      writeYaml(this.file("specialist-results.yaml"), freshSpecialistResults(this.feature));
    }
  }

  writeRequirements(data: Record<string, unknown>): ProductFeatureSnapshot {
    this.ensure();
    if (!isRecord(data.requirements)) throw new Error("requirements data must include a requirements object");
    const current = this.state();
    const baseline = typeof data.baseline === "number" && Number.isSafeInteger(data.baseline) && data.baseline > 0
      ? data.baseline
      : (current.requirements_baseline ?? 1);
    writeYaml(this.file("requirements.yaml"), withFeature(this.feature, { ...data, baseline }));
    const source = isRecord(data.source) ? data.source : undefined;
    const sourceType = source && typeof source.type === "string" && source.type.trim() ? source.type.trim() : "primary";
    this.writeState({
      requirements_baseline: baseline,
      specialist_status: { prd: "complete" },
      ...(source ? { sources: { [sourceType]: source } } : {}),
    });
    return this.snapshot();
  }

  writeScenarios(data: Record<string, unknown>): ProductFeatureSnapshot {
    this.ensure();
    if (!isRecord(data.scenarios)) throw new Error("scenario data must include a scenarios object");
    writeYaml(this.file("scenarios.yaml"), withFeature(this.feature, data));
    this.writeState({ specialist_status: { rbac: "complete" } });
    return this.snapshot();
  }

  writeDesignMap(data: Record<string, unknown>): ProductFeatureSnapshot {
    this.ensure();
    if (!isRecord(data.reuse_map)) throw new Error("design map data must include a reuse_map object");
    writeYaml(this.file("design-map.yaml"), withFeature(this.feature, data));
    this.writeState({ specialist_status: { ux: "complete" } });
    return this.snapshot();
  }

  setSpecialistStatus(data: Record<string, unknown>): ProductFeatureSnapshot {
    this.ensure();
    const statuses: Record<string, SpecialistStatus> = {};
    for (const [name, value] of Object.entries(data)) {
      if (!(name in DEFAULT_SPECIALIST_STATUS)) throw new Error(`Unknown specialist: ${name}`);
      if (value !== "pending" && value !== "running" && value !== "complete" && value !== "blocked") {
        throw new Error(`Invalid specialist status for ${name}`);
      }
      statuses[name] = value as SpecialistStatus;
    }
    if (Object.keys(statuses).length === 0) throw new Error("specialist status must name prd, archaeology, rbac, ux, or qa");
    this.writeState({ specialist_status: statuses });
    return this.snapshot();
  }

  recordSpecialistResult(data: Record<string, unknown>): ProductFeatureSnapshot {
    this.ensure();
    const specialist = data.specialist;
    if (typeof specialist !== "string" || !SPECIALIST_NAMES.includes(specialist as SpecialistName)) {
      throw new Error("specialist must be prd, archaeology, rbac, ux, or qa");
    }
    const status = data.status;
    if (status !== "resolved" && status !== "needs_deliberation" && status !== "blocked") {
      throw new Error("specialist result status must be resolved, needs_deliberation, or blocked");
    }
    if (typeof data.summary !== "string" || !data.summary.trim()) throw new Error("specialist result summary is required");
    for (const field of ["findings", "evidence", "affected_ids", "questions_for_agents"] as const) {
      if (data[field] !== undefined && !Array.isArray(data[field])) throw new Error(`${field} must be an array`);
    }

    const document = readYaml(this.file("specialist-results.yaml"), "specialist-results.yaml");
    const items = listItems(document, "items");
    const id = data.id === undefined ? nextRecordId("ANALYSIS", items) : assertRecordId(String(data.id), "ANALYSIS");
    if (items.some((item) => item.id === id)) throw new Error(`Specialist result already exists: ${id}`);
    const record = withFeature(this.feature, { ...data, id, recorded_at: now() });
    writeYaml(this.file("specialist-results.yaml"), { ...document, items: [...items, record] });
    this.writeState({
      specialist_status: {
        [specialist]: status === "resolved" ? "complete" : "blocked",
      },
    });
    return this.snapshot();
  }

  startRun(data: Record<string, unknown>): ProductRunRecord {
    this.ensure();
    if (typeof data.objective !== "string" || !data.objective.trim()) {
      throw new Error("run objective is required");
    }
    const directory = join(this.directory, RUN_DIR);
    const id = data.id === undefined
      ? nextRecordId("RUN", [], directory)
      : assertRecordId(String(data.id), "RUN");
    const path = join(directory, `${id}.yaml`);
    if (existsSync(path)) throw new Error(`Run already exists: ${id}`);
    const record = withFeature(this.feature, {
      ...data,
      id,
      objective: data.objective.trim(),
      status: "planned",
      phase: "planning",
      requirements_baseline: this.state().requirements_baseline,
      participants: [],
      tasks: [],
      discussions: [],
      created_at: now(),
      updated_at: now(),
    }) as ProductRunRecord;
    writeYaml(path, record);
    return record;
  }

  getRun(id: string): ProductRunRecord | undefined {
    const safeId = assertRecordId(id, "RUN");
    const path = join(this.directory, RUN_DIR, `${safeId}.yaml`);
    return existsSync(path) ? readYaml(path, `${safeId}.yaml`) as ProductRunRecord : undefined;
  }

  listRuns(): ProductRunRecord[] {
    this.ensure();
    return this.snapshot().runs as ProductRunRecord[];
  }

  updateRun(id: string, data: Record<string, unknown>): ProductRunRecord {
    this.ensure();
    const current = this.getRun(id);
    if (!current) throw new Error(`Run not found: ${id}`);
    if (data.status !== undefined && !["planned", "running", "waiting", "synthesizing", "clarification", "completed", "blocked", "failed"].includes(String(data.status))) {
      throw new Error("Invalid run status");
    }
    if (data.phase !== undefined && !["planning", "evidence", "fanout", "deliberating", "synthesis", "clarification", "writeback", "verification", "completed"].includes(String(data.phase))) {
      throw new Error("Invalid run phase");
    }
    const record = {
      ...current,
      ...data,
      version: 1,
      feature: this.feature,
      id: current.id,
      created_at: current.created_at,
      updated_at: now(),
    } as ProductRunRecord;
    writeYaml(join(this.directory, RUN_DIR, `${current.id}.yaml`), record);
    return record;
  }

  createDiscussion(data: Record<string, unknown>): ProductDiscussionRecord {
    this.ensure();
    if (typeof data.run_id !== "string" || !data.run_id.trim()) throw new Error("discussion run_id is required");
    if (!this.getRun(data.run_id)) throw new Error(`Run not found: ${data.run_id}`);
    if (typeof data.topic !== "string" || !data.topic.trim()) throw new Error("discussion topic is required");
    const directory = join(this.directory, DELIBERATION_DIR);
    const id = data.id === undefined
      ? nextRecordId("DISC", [], directory)
      : assertRecordId(String(data.id), "DISC");
    const path = join(directory, `${id}.yaml`);
    if (existsSync(path)) throw new Error(`Discussion already exists: ${id}`);
    const record = withFeature(this.feature, {
      ...data,
      id,
      topic: data.topic.trim(),
      status: "open",
      max_rounds: typeof data.max_rounds === "number" && Number.isInteger(data.max_rounds) && data.max_rounds > 0 ? data.max_rounds : 8,
      messages: [],
      created_at: now(),
      updated_at: now(),
    }) as ProductDiscussionRecord;
    writeYaml(path, record);
    const run = this.getRun(data.run_id) as ProductRunRecord;
    this.updateRun(run.id, { discussions: [...new Set([...(Array.isArray(run.discussions) ? run.discussions : []), id])] });
    return record;
  }

  getDiscussion(id: string): ProductDiscussionRecord | undefined {
    const safeId = assertRecordId(id, "DISC");
    const path = join(this.directory, DELIBERATION_DIR, `${safeId}.yaml`);
    return existsSync(path) ? readYaml(path, `${safeId}.yaml`) as ProductDiscussionRecord : undefined;
  }

  appendDiscussionMessage(discussionId: string, data: Record<string, unknown>): { discussion: ProductDiscussionRecord; message: Record<string, unknown>; duplicate: boolean } {
    this.ensure();
    const discussion = this.getDiscussion(discussionId);
    if (!discussion) throw new Error(`Discussion not found: ${discussionId}`);
    if (typeof data.kind !== "string" || !data.kind.trim()) throw new Error("message kind is required");
    const content = isRecord(data.content) ? data.content : undefined;
    const summary = typeof data.summary === "string" ? data.summary : content?.summary;
    if (typeof summary !== "string" || !summary.trim()) throw new Error("message summary is required");
    const messages = Array.isArray(discussion.messages) ? discussion.messages.filter(isRecord) : [];
    if (typeof data.message_id === "string") {
      const existing = messages.find((message) => message.message_id === data.message_id);
      if (existing) return { discussion, message: existing, duplicate: true };
    }
    let next = 1;
    for (const message of messages) {
      const match = typeof message.message_id === "string" ? message.message_id.match(/^MSG-(\\d+)$/) : null;
      if (match) next = Math.max(next, Number(match[1]) + 1);
    }
    const message = {
      ...data,
      message_id: typeof data.message_id === "string" ? data.message_id : `MSG-${String(next).padStart(3, "0")}`,
      created_at: typeof data.created_at === "string" ? data.created_at : now(),
      delivery: isRecord(data.delivery) ? data.delivery : { status: "accepted", attempts: 0 },
    };
    const updated = {
      ...discussion,
      messages: [...messages, message],
      updated_at: now(),
    } as ProductDiscussionRecord;
    writeYaml(join(this.directory, DELIBERATION_DIR, `${discussion.id}.yaml`), updated);
    return { discussion: updated, message, duplicate: false };
  }

  updateDiscussionMessage(discussionId: string, messageId: string, patch: Record<string, unknown>): ProductDiscussionRecord {
    this.ensure();
    const discussion = this.getDiscussion(discussionId);
    if (!discussion) throw new Error(`Discussion not found: ${discussionId}`);
    const messages = Array.isArray(discussion.messages) ? discussion.messages.filter(isRecord) : [];
    const index = messages.findIndex((message) => message.message_id === messageId);
    if (index < 0) throw new Error(`Message not found: ${messageId}`);
    messages[index] = { ...messages[index], ...patch, message_id: messageId };
    const updated = { ...discussion, messages, updated_at: now() } as ProductDiscussionRecord;
    writeYaml(join(this.directory, DELIBERATION_DIR, `${discussion.id}.yaml`), updated);
    return updated;
  }

  resolveDiscussion(id: string, data: Record<string, unknown>): ProductDiscussionRecord {
    const discussion = this.getDiscussion(id);
    if (!discussion) throw new Error(`Discussion not found: ${id}`);
    const status = data.status === undefined ? "resolved" : String(data.status);
    if (!["resolved", "escalated", "blocked"].includes(status)) throw new Error("Invalid discussion status");
    const updated = {
      ...discussion,
      ...data,
      id: discussion.id,
      feature: this.feature,
      version: 1,
      status,
      updated_at: now(),
    } as ProductDiscussionRecord;
    writeYaml(join(this.directory, DELIBERATION_DIR, `${discussion.id}.yaml`), updated);
    return updated;
  }
  recordFeedback(data: Record<string, unknown>): Record<string, unknown> {
    this.ensure();
    if (typeof data.source !== "string" || !data.source.trim()) throw new Error("feedback source is required");
    if (typeof data.source_id !== "string" || !data.source_id.trim()) throw new Error("feedback source_id is required");
    if (typeof data.summary !== "string" || !data.summary.trim()) throw new Error("feedback summary is required");
    const directory = join(this.directory, FEEDBACK_DIR);
    const existing = readDirectoryRecords(directory);
    if (existing.some((item) => item.source === data.source && item.source_id === data.source_id)) {
      return existing.find((item) => item.source === data.source && item.source_id === data.source_id) as Record<string, unknown>;
    }
    const id = data.id === undefined ? nextRecordId("FB", existing) : assertRecordId(String(data.id), "FB");
    const record = withFeature(this.feature, {
      ...data,
      id,
      status: "new",
      received_at: now(),
    });
    writeYaml(join(directory, `${id}.yaml`), record);
    return record;
  }

  recordExternalWrite(data: Record<string, unknown>): Record<string, unknown> {
    this.ensure();
    for (const field of ["source_id", "target", "operation", "idempotency_key"] as const) {
      if (typeof data[field] !== "string" || !data[field].trim()) throw new Error(`external write ${field} is required`);
    }
    if (!isRecord(data.precondition)) throw new Error("external write precondition is required");
    const directory = join(this.directory, EXTERNAL_WRITE_DIR);
    const existing = readDirectoryRecords(directory);
    const duplicate = existing.find((item) => item.idempotency_key === data.idempotency_key);
    if (duplicate) {
      if (duplicate.source_id !== data.source_id || duplicate.target !== data.target || duplicate.operation !== data.operation) {
        throw new Error(`External write idempotency key conflicts with an existing write: ${data.idempotency_key}`);
      }
      return duplicate;
    }
    const id = data.id === undefined ? nextRecordId("WRITE", existing) : assertRecordId(String(data.id), "WRITE");
    const record = withFeature(this.feature, {
      ...data,
      id,
      status: "proposed",
      receipt: null,
      proposed_at: now(),
      updated_at: now(),
    });
    writeYaml(join(directory, `${id}.yaml`), record);
    return record;
  }

  getExternalWrite(id: string): Record<string, unknown> | undefined {
    const safeId = assertRecordId(id, "WRITE");
    const path = join(this.directory, EXTERNAL_WRITE_DIR, `${safeId}.yaml`);
    return existsSync(path) ? readYaml(path, `${safeId}.yaml`) : undefined;
  }

  updateExternalWrite(id: string, data: Record<string, unknown>): Record<string, unknown> {
    this.ensure();
    const current = this.getExternalWrite(id);
    if (!current) throw new Error(`External write not found: ${id}`);
    const statuses: ProductExternalWriteStatus[] = ["proposed", "approved", "pending", "written", "verified", "reconciled", "partially_reconciled", "failed"];
    const nextStatus = data.status === undefined ? String(current.status) : String(data.status);
    if (!statuses.includes(nextStatus as ProductExternalWriteStatus)) throw new Error(`Invalid external write status: ${nextStatus}`);
    const allowed: Record<string, string[]> = {
      proposed: ["approved", "failed"],
      approved: ["pending", "failed"],
      pending: ["written", "failed", "partially_reconciled"],
      written: ["verified", "failed", "partially_reconciled"],
      verified: ["reconciled", "partially_reconciled", "failed"],
      reconciled: [],
      partially_reconciled: ["pending", "verified", "reconciled", "failed"],
      failed: ["proposed", "approved", "pending"],
    };
    if (nextStatus !== current.status && !allowed[String(current.status)]?.includes(nextStatus)) {
      throw new Error(`Invalid external write transition: ${String(current.status)} -> ${nextStatus}`);
    }
    const updated = {
      ...current,
      ...data,
      id: current.id,
      feature: this.feature,
      version: 1,
      status: nextStatus,
      updated_at: now(),
    };
    writeYaml(join(this.directory, EXTERNAL_WRITE_DIR, `${current.id}.yaml`), updated);
    return updated;
  }

  recordVerification(data: Record<string, unknown>): Record<string, unknown> {
    this.ensure();
    if (typeof data.external_write_id !== "string" || !this.getExternalWrite(data.external_write_id)) throw new Error("verification external_write_id must reference an external write");
    if (data.status !== "passed" && data.status !== "failed" && data.status !== "partial") throw new Error("verification status must be passed, failed, or partial");
    if (typeof data.summary !== "string" || !data.summary.trim()) throw new Error("verification summary is required");
    const directory = join(this.directory, VERIFICATION_DIR);
    const existing = readDirectoryRecords(directory);
    const id = data.id === undefined ? nextRecordId("VERIFY", existing) : assertRecordId(String(data.id), "VERIFY");
    const record = withFeature(this.feature, { ...data, id, recorded_at: now() });
    writeYaml(join(directory, `${id}.yaml`), record);
    return record;
  }
  recordDeliberation(data: Record<string, unknown>): Record<string, unknown> {
    this.ensure();
    const directory = join(this.directory, DELIBERATION_DIR);
    const id = data.id === undefined
      ? nextRecordId("DISC", [], directory)
      : assertRecordId(String(data.id), "DISC");
    const path = join(directory, `${id}.yaml`);
    if (existsSync(path)) throw new Error(`Deliberation already exists: ${id}`);
    const record = withFeature(this.feature, { ...data, id, recorded_at: now() });
    writeYaml(path, record);
    return record;
  }

  requestClarification(data: Record<string, unknown>): ProductFeatureSnapshot {
    this.ensure();
    if (typeof data.question !== "string" || !data.question.trim()) throw new Error("clarification question is required");
    const document = readYaml(this.file("clarifications.yaml"), "clarifications.yaml");
    const items = listItems(document, "clarifications");
    const id = data.id === undefined ? nextRecordId("CLAR", items) : assertRecordId(String(data.id), "CLAR");
    if (items.some((item) => item.id === id)) throw new Error(`Clarification already exists: ${id}`);
    const record = withFeature(this.feature, { ...data, id, status: "open", created_at: now() });
    writeYaml(this.file("clarifications.yaml"), { ...document, clarifications: [...items, record] });
    this.writeState({
      lifecycle: { phase: "clarification" },
      open_clarifications: [...new Set([...this.state().open_clarifications, id])],
    });
    return this.snapshot();
  }

  recordDecision(data: Record<string, unknown>): ProductFeatureSnapshot {
    this.ensure();
    if (typeof data.decision !== "string" || !data.decision.trim()) throw new Error("decision is required");
    const document = readYaml(this.file("decisions.yaml"), "decisions.yaml");
    const items = listItems(document, "items");
    const id = data.id === undefined ? nextRecordId("DEC", items) : assertRecordId(String(data.id), "DEC");
    if (items.some((item) => item.id === id)) throw new Error(`Decision already exists: ${id}`);

    const clarificationId = typeof data.clarification_id === "string" ? data.clarification_id : undefined;
    const clarifications = readYaml(this.file("clarifications.yaml"), "clarifications.yaml");
    const clarificationItems = listItems(clarifications, "clarifications");
    const clarification = clarificationId
      ? clarificationItems.find((item) => item.id === clarificationId)
      : undefined;
    if (clarificationId && (!clarification || clarification.status !== "open")) {
      throw new Error(`Open clarification not found: ${clarificationId}`);
    }

    const record = withFeature(this.feature, { ...data, id, status: "accepted", recorded_at: now() });
    writeYaml(this.file("decisions.yaml"), { ...document, items: [...items, record] });

    const open = new Set(this.state().open_clarifications);
    if (clarificationId) {
      open.delete(clarificationId);
      writeYaml(this.file("clarifications.yaml"), {
        ...clarifications,
        clarifications: clarificationItems.map((item) => item.id === clarificationId
          ? { ...item, status: "resolved", decision_id: id, resolved_at: now() }
          : item),
      });
    }
    this.writeState({
      lifecycle: { phase: "design_iteration", iteration: this.state().lifecycle.iteration + 1 },
      latest_decision: id,
      open_clarifications: [...open],
    });
    return this.snapshot();
  }

  recordChange(data: Record<string, unknown>): ProductFeatureSnapshot {
    this.ensure();
    if (typeof data.summary !== "string" || !data.summary.trim()) throw new Error("change summary is required");
    const document = readYaml(this.file("changes.yaml"), "changes.yaml");
    const items = listItems(document, "items");
    const id = data.id === undefined ? nextRecordId("CHG", items) : assertRecordId(String(data.id), "CHG");
    if (items.some((item) => item.id === id)) throw new Error(`Change already exists: ${id}`);
    const record = withFeature(this.feature, { ...data, id, recorded_at: now() });
    writeYaml(this.file("changes.yaml"), { ...document, items: [...items, record] });
    return this.snapshot();
  }

  updateReadiness(data: Record<string, unknown>): ProductFeatureSnapshot {
    this.ensure();
    const allowed = new Set(Object.keys(DEFAULT_READINESS));
    for (const key of Object.keys(data)) {
      if (!allowed.has(key)) throw new Error(`Unknown readiness field: ${key}`);
    }
    const patch: Partial<ProductReadiness> = {};
    for (const key of Object.keys(DEFAULT_READINESS) as Array<keyof ProductReadiness>) {
      if (typeof data[key] === "boolean") patch[key] = data[key] as boolean;
      else if (data[key] !== undefined) throw new Error(`${key} must be boolean`);
    }
    if (Object.keys(patch).length === 0) throw new Error("readiness update must include at least one boolean gate field");
    this.writeState({ readiness: patch });
    return this.snapshot();
  }

  readiness(gate: ReadinessResult["gate"]): ReadinessResult {
    this.ensure();
    const snapshot = this.snapshot();
    const { state } = snapshot;
    const checks: ReadinessCheck[] = [];
    const add = (id: string, label: string, passed: boolean, detail: string, blocking = true) => {
      checks.push({ id, label, passed, blocking, detail });
    };
    const scenarioMap = snapshot.scenarios.scenarios;
    const reuseMap = snapshot.designMap.reuse_map;
    const hasScenarios = isRecord(scenarioMap) && Object.keys(scenarioMap).length > 0;
    const hasSource = Object.keys(state.sources).length > 0 || hasContent(snapshot.requirements.source);
    const hasActors = Array.isArray(snapshot.requirements.actors) && snapshot.requirements.actors.length > 0;
    const hasScope = hasContent(snapshot.requirements.scope);
    const hasAcceptanceCriteria = hasContent(snapshot.requirements.acceptance_criteria);
    const specialistResults = listItems(snapshot.specialistResults, "items");
    const hasResolvedSpecialist = (name: SpecialistName): boolean => {
      const latest = [...specialistResults].reverse().find((item) => item.specialist === name);
      return state.specialist_status[name] === "complete" && latest?.status === "resolved";
    };
    add("requirements-baseline", "Requirements baseline captured", state.requirements_baseline !== null,
      state.requirements_baseline === null ? "Capture a Jira/PRD baseline first." : `Baseline ${state.requirements_baseline} is recorded.`);
    add("prd", "PRD analysis completed", hasResolvedSpecialist("prd"),
      hasResolvedSpecialist("prd") ? "PRD analysis is recorded." : "Persist a resolved PRD specialist result.");
    add("requirement-source", "Requirement source captured", hasSource,
      hasSource ? "Source references are recorded." : "Record the Jira, fixture, or approved source reference.");
    add("actors", "Actors identified", hasActors,
      hasActors ? "Actors are recorded." : "Record at least one actor in requirements.yaml.");
    add("scope", "Scope identified", hasScope,
      hasScope ? "Scope is recorded." : "Record the feature scope in requirements.yaml.");
    add("acceptance-criteria", "Acceptance criteria captured", hasAcceptanceCriteria,
      hasAcceptanceCriteria ? "Acceptance criteria are recorded." : "Record acceptance criteria in requirements.yaml.");
    add("archaeology", "Product archaeology completed", hasResolvedSpecialist("archaeology"),
      hasResolvedSpecialist("archaeology") ? "Existing product/Figma patterns are recorded." : "Run and persist the product archaeologist result.");
    add("reuse-map", "Reuse / extend / gap map completed", isRecord(reuseMap) && Object.keys(reuseMap).length > 0,
      isRecord(reuseMap) && Object.keys(reuseMap).length > 0 ? "Design reuse map is present." : "Record reuse_map before proposing new UI.");
    add("rbac", "Material RBAC scenarios identified", hasResolvedSpecialist("rbac") && hasScenarios,
      hasResolvedSpecialist("rbac") && hasScenarios ? "Scenario matrix is present." : "Run and persist the RBAC/scenario analyst result.");
    add("clarifications", "No blocking clarification is open", state.open_clarifications.length === 0,
      state.open_clarifications.length === 0 ? "No open clarifications." : `Open: ${state.open_clarifications.join(", ")}`);

    if (gate === "before_feedback" || gate === "ready_for_dev") {
      add("feedback-rule", "Feedback has been converted into a product rule", state.readiness.feedback_processed,
        state.readiness.feedback_processed ? "Feedback impact is recorded." : "Record the feedback impact before applying it.");
      add("contradictions", "Contradictions are resolved", state.readiness.contradictions_resolved,
        state.readiness.contradictions_resolved ? "No unresolved contradiction is recorded." : "Resolve or escalate contradictory evidence.");
    }
    if (gate === "ready_for_dev") {
      add("annotations", "Material design deltas are annotated", state.readiness.material_deltas_annotated,
        state.readiness.material_deltas_annotated ? "Design annotations are marked complete." : "Annotate every material delta.");
      add("prd-reconciled", "PRD is reconciled", state.readiness.prd_reconciled,
        state.readiness.prd_reconciled ? "Canonical requirements match the approved decision." : "Reconcile the PRD/Jira delta.");
      add("figma-reconciled", "Figma is reconciled", state.readiness.figma_reconciled,
        state.readiness.figma_reconciled ? "Design state matches the approved decision." : "Reconcile Figma and record the design version.");
      add("ux", "UX analysis completed", hasResolvedSpecialist("ux"),
        hasResolvedSpecialist("ux") ? "UX analysis is recorded." : "Run and persist the product designer result.");
      add("qa", "QA challenge completed", hasResolvedSpecialist("qa"),
        hasResolvedSpecialist("qa") ? "QA challenge is complete." : "Run and persist the QA challenger result.");
    }

    const missing = checks.filter((check) => !check.passed && check.blocking).map((check) => check.label);
    return { feature: this.feature, gate, ready: missing.length === 0, checks, missing };
  }
}

export function createProductFeatureStore(cwd: string, feature: string): ProductFeatureStore {
  return new ProductFeatureStore(cwd, feature);
}

export function isProductFeatureId(value: string): boolean {
  return FEATURE_ID_PATTERN.test(value.trim());
}
