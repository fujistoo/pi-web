import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

export const TEAM_FEATURES_DIR = ".pi/teams/features";

export const TEAM_LIFECYCLE_STATUSES = [
  "planned",
  "active",
  "integrating",
  "awaiting_approval",
  "completed",
  "decommissioned",
  "blocked",
  "paused",
  "failed",
] as const;
export type TeamLifecycleStatus = (typeof TEAM_LIFECYCLE_STATUSES)[number];

export const TEAM_ESCALATION_REASONS = [
  "need_decision",
  "interview_request",
  "progress_update",
] as const;
export type TeamEscalationReason = (typeof TEAM_ESCALATION_REASONS)[number];

export const TEAM_TASK_STATUSES = ["planned", "active", "blocked", "paused", "completed", "failed"] as const;
export type TeamTaskStatus = (typeof TEAM_TASK_STATUSES)[number];
export type TeamParticipantRole = "main" | "lead" | "member";
export type TeamWriteScope = "source" | "state" | "read";
export type TeamMessageDeliveryStatus = "pending" | "delivered" | "failed";

export interface TeamParticipant {
  id: string;
  role: TeamParticipantRole;
  parent_id: string | null;
  depth: 0 | 1 | 2;
  write_scope: TeamWriteScope;
  worktree: string | null;
  session_id: string | null;
  joined_at: string;
}

export interface TeamTask {
  id: string;
  title: string;
  owner_id: string | null;
  dependencies: string[];
  status: TeamTaskStatus;
  created_at: string;
  updated_at: string;
}

export interface TeamMessage {
  id: string;
  sender_id: string;
  recipient_id: string;
  body: string;
  delivery: {
    status: TeamMessageDeliveryStatus;
    attempts: number;
    updated_at: string;
    error?: string;
  };
  created_at: string;
}

export interface TeamEscalation {
  id: string;
  sender_id: string;
  reason: TeamEscalationReason;
  message: string;
  interview?: { title: string; questions: unknown[] };
  status: "open" | "resolved";
  blocking: boolean;
  response?: string;
  created_at: string;
  resolved_at?: string;
}

export interface TeamFeatureRecord {
  version: 1;
  feature: string;
  lifecycle: TeamLifecycleStatus;
  participants: TeamParticipant[];
  tasks: TeamTask[];
  messages: TeamMessage[];
  escalations: TeamEscalation[];
  state: Record<string, unknown>;
  source: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  decommissioned_at?: string;
}

export interface TeamCleanupTargets {
  feature: string;
  worktrees: string[];
  sessions: string[];
}

const FEATURE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const lifecycleSet = new Set<string>(TEAM_LIFECYCLE_STATUSES);
const escalationSet = new Set<string>(TEAM_ESCALATION_REASONS);
const taskStatusSet = new Set<string>(TEAM_TASK_STATUSES);

function timestamp(): string {
  return new Date().toISOString();
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value.trim())) throw new Error(`${label} is invalid`);
  return value.trim();
}

function featureId(value: string): string {
  const normalized = value.trim();
  if (!FEATURE_PATTERN.test(normalized)) {
    throw new Error("Feature id may contain only letters, numbers, dots, underscores, and hyphens");
  }
  return normalized;
}

function assertProjectDirectory(cwd: string): string {
  const root = realpathSync(resolve(cwd));
  const target = join(root, TEAM_FEATURES_DIR);
  const child = relative(root, target);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("Team state must remain inside the project cwd");
  }
  return root;
}

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function uniqueStrings(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function assertRecordShape(record: TeamFeatureRecord, expectedFeature: string): void {
  if (record.version !== 1 || record.feature !== expectedFeature) throw new Error("Team record identity is invalid");
  if (!lifecycleSet.has(record.lifecycle)) throw new Error("Team lifecycle is invalid");
  if (!Array.isArray(record.participants) || !Array.isArray(record.tasks) || !Array.isArray(record.messages) || !Array.isArray(record.escalations)) {
    throw new Error("Team record collections are invalid");
  }
}

export class TeamFeatureStore {
  readonly cwd: string;
  readonly feature: string;
  readonly directory: string;
  readonly path: string;

  constructor(cwd: string, feature: string) {
    this.cwd = assertProjectDirectory(cwd);
    this.feature = featureId(feature);
    this.directory = join(this.cwd, TEAM_FEATURES_DIR);
    this.path = join(this.directory, `${this.feature}.json`);
  }

  exists(): boolean {
    return existsSync(this.path);
  }

  create(main: { id: string; session_id?: string | null; worktree?: string | null }): TeamFeatureRecord {
    if (this.exists()) throw new Error(`Team already exists: ${this.feature}`);
    const created = timestamp();
    const record: TeamFeatureRecord = {
      version: 1,
      feature: this.feature,
      lifecycle: "planned",
      participants: [{
        id: identifier(main.id, "Main participant id"),
        role: "main",
        parent_id: null,
        depth: 0,
        write_scope: "source",
        worktree: typeof main.worktree === "string" && main.worktree ? main.worktree : null,
        session_id: typeof main.session_id === "string" && main.session_id ? main.session_id : null,
        joined_at: created,
      }],
      tasks: [],
      messages: [],
      escalations: [],
      state: {},
      source: {},
      created_at: created,
      updated_at: created,
    };
    atomicWrite(this.path, record);
    return record;
  }

  read(): TeamFeatureRecord {
    if (!this.exists()) throw new Error(`Team not found: ${this.feature}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (error) {
      throw new Error(`Unable to read team ${this.feature}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const record = object(parsed, "Team record") as unknown as TeamFeatureRecord;
    assertRecordShape(record, this.feature);
    return record;
  }

  addParticipant(input: {
    id: string;
    role: "lead" | "member";
    parent_id: string;
    write_scope?: TeamWriteScope;
    worktree?: string | null;
    session_id?: string | null;
  }): TeamParticipant {
    const record = this.mutable();
    const id = identifier(input.id, "Participant id");
    if (record.participants.some((participant) => participant.id === id)) throw new Error(`Participant already exists: ${id}`);
    const parentId = identifier(input.parent_id, "Parent participant id");
    const parent = this.participant(record, parentId);
    if (input.role === "lead" && parent.role !== "main") throw new Error("A lead must report to main");
    if (input.role === "lead" && record.participants.some((participant) => participant.role === "lead")) {
      throw new Error("A feature team may have only one lead");
    }
    if (input.role === "member" && parent.role !== "lead") throw new Error("A member must report to the lead");
    const depth = (parent.depth + 1) as 1 | 2;
    if (depth > 2) throw new Error("Team delegation depth cannot exceed 2");
    if (input.role === "lead" && input.write_scope && input.write_scope !== "state") {
      throw new Error("Leads may write team state, not source");
    }
    const participant: TeamParticipant = {
      id,
      role: input.role,
      parent_id: parentId,
      depth,
      write_scope: input.role === "lead" ? "state" : input.write_scope ?? "source",
      worktree: typeof input.worktree === "string" && input.worktree ? input.worktree : null,
      session_id: typeof input.session_id === "string" && input.session_id ? input.session_id : null,
      joined_at: timestamp(),
    };
    record.participants.push(participant);
    this.save(record);
    return participant;
  }

  writeState(actorId: string, patch: Record<string, unknown>): TeamFeatureRecord {
    const record = this.mutable();
    const actor = this.participant(record, identifier(actorId, "Actor id"));
    if (actor.role === "member" || actor.write_scope === "read") throw new Error("Actor may not write team state");
    if ("source" in patch) throw new Error("Source changes must use writeSource");
    record.state = { ...record.state, ...object(patch, "State patch") };
    return this.save(record);
  }

  writeSource(actorId: string, patch: Record<string, unknown>): TeamFeatureRecord {
    const record = this.mutable();
    const actor = this.participant(record, identifier(actorId, "Actor id"));
    if (actor.role === "lead") throw new Error("Leads may write team state, not source");
    if (actor.write_scope !== "source") throw new Error("Actor may not write source");
    record.source = { ...record.source, ...object(patch, "Source patch") };
    return this.save(record);
  }

  addTask(input: { id: string; title: string; owner_id?: string | null; dependencies?: string[] }): TeamTask {
    const record = this.mutable();
    const id = identifier(input.id, "Task id");
    if (record.tasks.some((task) => task.id === id)) throw new Error(`Task already exists: ${id}`);
    const dependencies = this.dependencies(record, input.dependencies ?? [], id);
    const ownerId = input.owner_id === undefined || input.owner_id === null ? null : identifier(input.owner_id, "Task owner id");
    if (ownerId) this.participant(record, ownerId);
    if (typeof input.title !== "string" || !input.title.trim()) throw new Error("Task title is required");
    const created = timestamp();
    const task: TeamTask = {
      id,
      title: input.title.trim(),
      owner_id: ownerId,
      dependencies,
      status: "planned",
      created_at: created,
      updated_at: created,
    };
    record.tasks.push(task);
    this.save(record);
    return task;
  }

  updateTask(idValue: string, patch: { status?: TeamTaskStatus; dependencies?: string[]; owner_id?: string | null }): TeamTask {
    const record = this.mutable();
    const id = identifier(idValue, "Task id");
    const task = record.tasks.find((candidate) => candidate.id === id);
    if (!task) throw new Error(`Task not found: ${id}`);
    if (patch.status !== undefined) {
      if (!taskStatusSet.has(patch.status)) throw new Error("Task status is invalid");
      if (patch.status === "active") {
        const waiting = task.dependencies.filter((dependency) => record.tasks.find((candidate) => candidate.id === dependency)?.status !== "completed");
        if (waiting.length) throw new Error(`Task ${id} is waiting on: ${waiting.join(", ")}`);
      }
      task.status = patch.status;
    }
    if (patch.dependencies !== undefined) {
      task.dependencies = this.dependencies(record, patch.dependencies, id);
      this.assertNoTaskCycles(record.tasks);
    }
    if (patch.owner_id !== undefined) {
      task.owner_id = patch.owner_id === null ? null : identifier(patch.owner_id, "Task owner id");
      if (task.owner_id) this.participant(record, task.owner_id);
    }
    task.updated_at = timestamp();
    this.save(record);
    return task;
  }

  readyTasks(): TeamTask[] {
    const record = this.read();
    return record.tasks.filter((task) => task.status === "planned" && task.dependencies.every((dependency) =>
      record.tasks.find((candidate) => candidate.id === dependency)?.status === "completed"));
  }

  createDirectMessage(input: { id?: string; sender_id: string; recipient_id: string; body: string }): TeamMessage {
    const record = this.mutable();
    const senderId = identifier(input.sender_id, "Message sender id");
    const recipientId = identifier(input.recipient_id, "Message recipient id");
    this.participant(record, senderId);
    this.participant(record, recipientId);
    if (senderId === recipientId) throw new Error("A direct message requires a different recipient");
    if (typeof input.body !== "string" || !input.body.trim()) throw new Error("Message body is required");
    const id = input.id ? identifier(input.id, "Message id") : `MSG-${randomUUID()}`;
    if (record.messages.some((message) => message.id === id)) throw new Error(`Message already exists: ${id}`);
    const created = timestamp();
    const message: TeamMessage = {
      id,
      sender_id: senderId,
      recipient_id: recipientId,
      body: input.body.trim(),
      delivery: { status: "pending", attempts: 0, updated_at: created },
      created_at: created,
    };
    record.messages.push(message);
    this.save(record);
    return message;
  }

  markMessageDelivery(idValue: string, status: "delivered" | "failed", error?: string): TeamMessage {
    const record = this.mutable();
    const id = identifier(idValue, "Message id");
    const message = record.messages.find((candidate) => candidate.id === id);
    if (!message) throw new Error(`Message not found: ${id}`);
    message.delivery = {
      status,
      attempts: message.delivery.attempts + 1,
      updated_at: timestamp(),
      ...(status === "failed" && error ? { error } : {}),
    };
    this.save(record);
    return message;
  }

  recordEscalation(input: {
    id?: string;
    sender_id: string;
    reason: TeamEscalationReason;
    message: string;
    interview?: { title: string; questions: unknown[] };
  }): TeamEscalation {
    const record = this.mutable();
    const sender = this.participant(record, identifier(input.sender_id, "Escalation sender id"));
    if (sender.role !== "lead") throw new Error("Only the feature lead may escalate to main");
    if (!escalationSet.has(input.reason)) throw new Error("Escalation reason is invalid");
    if (typeof input.message !== "string" || !input.message.trim()) throw new Error("Escalation message is required");
    if (input.reason === "interview_request" && (!input.interview || !Array.isArray(input.interview.questions))) {
      throw new Error("interview_request requires structured interview questions");
    }
    const escalation: TeamEscalation = {
      id: input.id ? identifier(input.id, "Escalation id") : `ESC-${randomUUID()}`,
      sender_id: sender.id,
      reason: input.reason,
      message: input.message.trim(),
      ...(input.interview ? { interview: input.interview } : {}),
      status: "open",
      blocking: input.reason !== "progress_update",
      created_at: timestamp(),
    };
    if (record.escalations.some((candidate) => candidate.id === escalation.id)) throw new Error(`Escalation already exists: ${escalation.id}`);
    record.escalations.push(escalation);
    if (escalation.blocking) record.lifecycle = "awaiting_approval";
    this.save(record);
    return escalation;
  }

  resolveEscalation(actorId: string, escalationId: string, response: string): TeamEscalation {
    const record = this.mutable();
    const actor = this.participant(record, identifier(actorId, "Actor id"));
    if (actor.role !== "main") throw new Error("Only main may resolve an escalation");
    const escalation = record.escalations.find((candidate) => candidate.id === identifier(escalationId, "Escalation id"));
    if (!escalation) throw new Error(`Escalation not found: ${escalationId}`);
    escalation.status = "resolved";
    escalation.response = response;
    escalation.resolved_at = timestamp();
    if (record.lifecycle === "awaiting_approval" && !record.escalations.some((candidate) => candidate.blocking && candidate.status === "open")) {
      record.lifecycle = "active";
    }
    this.save(record);
    return escalation;
  }

  transition(status: TeamLifecycleStatus): TeamFeatureRecord {
    if (!lifecycleSet.has(status)) throw new Error("Team lifecycle is invalid");
    if (status === "decommissioned") throw new Error("Use decommission() to retain cleanup targets");
    const record = this.mutable();
    record.lifecycle = status;
    return this.save(record);
  }

  cleanupTargets(): TeamCleanupTargets {
    const record = this.read();
    return {
      feature: record.feature,
      worktrees: uniqueStrings(record.participants.map((participant) => participant.worktree)),
      sessions: uniqueStrings(record.participants.map((participant) => participant.session_id)),
    };
  }

  decommission(actorId: string): { record: TeamFeatureRecord; cleanup: TeamCleanupTargets } {
    const record = this.mutable(true);
    const actor = this.participant(record, identifier(actorId, "Actor id"));
    if (actor.role !== "main") throw new Error("Only main may decommission a team");
    if (record.lifecycle !== "completed" && record.lifecycle !== "decommissioned") {
      throw new Error("Only a completed team may be decommissioned");
    }
    const cleanup = {
      feature: record.feature,
      worktrees: uniqueStrings(record.participants.map((participant) => participant.worktree)),
      sessions: uniqueStrings(record.participants.map((participant) => participant.session_id)),
    };
    if (record.lifecycle !== "decommissioned") {
      record.lifecycle = "decommissioned";
      record.decommissioned_at = timestamp();
      this.save(record, true);
    }
    return { record, cleanup };
  }

  private mutable(allowDecommissioned = false): TeamFeatureRecord {
    const record = this.read();
    if (!allowDecommissioned && record.lifecycle === "decommissioned") throw new Error("Team is decommissioned");
    return record;
  }

  private participant(record: TeamFeatureRecord, id: string): TeamParticipant {
    const participant = record.participants.find((candidate) => candidate.id === id);
    if (!participant) throw new Error(`Participant not found: ${id}`);
    return participant;
  }

  private dependencies(record: TeamFeatureRecord, values: string[], ownId: string): string[] {
    if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) throw new Error("Task dependencies must be an array of strings");
    const dependencies = [...new Set(values.map((value) => identifier(value, "Task dependency id")))];
    if (dependencies.includes(ownId)) throw new Error(`Task cannot depend on itself: ${ownId}`);
    const missing = dependencies.filter((dependency) => !record.tasks.some((task) => task.id === dependency));
    if (missing.length) throw new Error(`Task has missing dependencies: ${missing.join(", ")}`);
    return dependencies;
  }

  private assertNoTaskCycles(tasks: TeamTask[]): void {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string) => {
      if (visiting.has(id)) throw new Error("Task dependencies must not contain a cycle");
      if (visited.has(id)) return;
      visiting.add(id);
      tasks.find((task) => task.id === id)?.dependencies.forEach(visit);
      visiting.delete(id);
      visited.add(id);
    };
    tasks.forEach((task) => visit(task.id));
  }

  private save(record: TeamFeatureRecord, allowDecommissioned = false): TeamFeatureRecord {
    if (!allowDecommissioned && record.lifecycle === "decommissioned") throw new Error("Team is decommissioned");
    record.updated_at = timestamp();
    atomicWrite(this.path, record);
    return record;
  }
}

export function listTeamFeatures(cwd: string): TeamFeatureRecord[] {
  const root = assertProjectDirectory(cwd);
  const directory = join(root, TEAM_FEATURES_DIR);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => new TeamFeatureStore(root, name.slice(0, -5)).read())
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
}
