import {
  ProductFeatureStore,
  type ProductRunRecord,
} from "./product-state";

export const PRODUCT_TASK_STATUSES = [
  "pending",
  "running",
  "waiting",
  "completed",
  "failed",
  "blocked",
  "stale",
] as const;

export type ProductTaskStatus = (typeof PRODUCT_TASK_STATUSES)[number];
export type ProductTaskOutcomeStatus = "resolved" | "needs_deliberation" | "blocked" | "failed";

export interface ProductRunTask {
  id: string;
  role: string;
  description: string;
  dependencies: string[];
  attempt: number;
  max_attempts: number;
  status: ProductTaskStatus;
  requirements_baseline: number | null;
  stale: boolean;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export interface ProductTaskOutcome {
  status: ProductTaskOutcomeStatus;
  summary: string;
  findings?: string[];
  evidence?: string[];
  affected_ids?: string[];
  questions_for_agents?: string[];
  requirements_baseline?: number | null;
}

export interface ProductRunEvidence {
  id: string;
  source: string;
  source_id: string;
  source_version?: string | number;
  freshness: "current" | "stale" | "unknown";
  captured_at: string;
  [key: string]: unknown;
}

export interface ProductRunJoin {
  run_id: string;
  run_status: ProductRunRecord["status"];
  phase: ProductRunRecord["phase"];
  task_count: number;
  completed_task_ids: string[];
  ready_task_ids: string[];
  running_task_ids: string[];
  blocked_task_ids: string[];
  stale_task_ids: string[];
  failed_task_ids: string[];
  can_synthesize: boolean;
  needs_attention: boolean;
}

const runMutationQueues = new Map<string, Promise<void>>();

// ponytail: one process-local lock per run; use a file lock if multiple pi-web processes mutate one feature.
async function withRunMutationLock<T>(key: string, operation: () => T | Promise<T>): Promise<T> {
  const previous = runMutationQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  runMutationQueues.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (runMutationQueues.get(key) === current) runMutationQueues.delete(key);
  }
}

function now(): string {
  return new Date().toISOString();
}

function taskId(value: unknown): string {
  if (typeof value !== "string" || !/^TASK-[0-9]{3,}$/.test(value)) throw new Error("Task id must look like TASK-001");
  return value;
}

function list(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(`${field} must be an array of strings`);
  return [...value];
}

function tasksOf(run: ProductRunRecord): ProductRunTask[] {
  return (Array.isArray(run.tasks) ? run.tasks : []).filter((item): item is ProductRunTask =>
    Boolean(item && typeof item === "object" && !Array.isArray(item)),
  );
}

function findTask(run: ProductRunRecord, id: string): ProductRunTask {
  const task = tasksOf(run).find((item) => item.id === id);
  if (!task) throw new Error(`Task not found: ${id}`);
  return task;
}

export class ProductRunCoordinator {
  readonly store: ProductFeatureStore;
  readonly runId: string;

  constructor(options: { store: ProductFeatureStore; runId: string }) {
    this.store = options.store;
    this.runId = options.runId;
    if (!this.store.getRun(this.runId)) throw new Error(`Run not found: ${this.runId}`);
  }

  static start(store: ProductFeatureStore, data: Record<string, unknown>): ProductRunRecord {
    const run = store.startRun(data);
    return store.updateRun(run.id, { status: "running", phase: "evidence" });
  }

  async addEvidence(data: Record<string, unknown>): Promise<ProductRunEvidence> {
    return this.mutate(() => {
      const run = this.requireRun();
      if (typeof data.source !== "string" || !data.source.trim()) throw new Error("Evidence source is required");
      if (typeof data.source_id !== "string" || !data.source_id.trim()) throw new Error("Evidence source_id is required");
      const existing = Array.isArray(run.evidence) ? run.evidence.filter((item) => item && typeof item === "object" && !Array.isArray(item)) as ProductRunEvidence[] : [];
      const duplicate = existing.find((item) => item.source === data.source && item.source_id === data.source_id && item.source_version === data.source_version);
      if (duplicate) return duplicate;
      const id = `EVID-${String(existing.length + 1).padStart(3, "0")}`;
      const evidence = {
        ...data,
        id,
        source: data.source.trim(),
        source_id: data.source_id.trim(),
        freshness: data.freshness === "stale" || data.freshness === "unknown" ? data.freshness : "current",
        captured_at: typeof data.captured_at === "string" ? data.captured_at : now(),
      } as ProductRunEvidence;
      this.store.updateRun(this.runId, { evidence: [...existing, evidence] });
      return evidence;
    });
  }

  async markEvidenceStale(ids: string[], reason: string): Promise<ProductRunEvidence[]> {
    return this.mutate(() => {
      if (!Array.isArray(ids) || ids.length === 0) throw new Error("At least one evidence id is required");
      if (typeof reason !== "string" || !reason.trim()) throw new Error("Evidence stale reason is required");
      const run = this.requireRun();
      const wanted = new Set(ids);
      const evidence = Array.isArray(run.evidence) ? run.evidence.filter((item) => item && typeof item === "object" && !Array.isArray(item)) as ProductRunEvidence[] : [];
      const updated = evidence.map((item) => wanted.has(item.id) ? { ...item, freshness: "stale" as const, stale_reason: reason.trim(), updated_at: now() } : item);
      if (updated.filter((item) => wanted.has(item.id)).length !== wanted.size) throw new Error("One or more evidence ids were not found");
      const tasks = tasksOf(run).map((task) => {
        const outcome = task.outcome && typeof task.outcome === "object" && !Array.isArray(task.outcome) ? task.outcome as Record<string, unknown> : undefined;
        const refs = Array.isArray(outcome?.evidence) ? outcome.evidence : [];
        return refs.some((ref) => typeof ref === "string" && wanted.has(ref))
          ? { ...task, status: "stale" as const, stale: true, stale_reason: reason.trim(), updated_at: now() }
          : task;
      });
      this.store.updateRun(this.runId, { status: "waiting", phase: "evidence", evidence: updated, tasks });
      return updated.filter((item) => wanted.has(item.id));
    });
  }

  async invalidateByAffectedIds(affectedIds: string[], reason: string): Promise<ProductRunTask[]> {
    return this.mutate(() => {
      if (!Array.isArray(affectedIds) || affectedIds.length === 0) throw new Error("At least one affected id is required");
      if (typeof reason !== "string" || !reason.trim()) throw new Error("Stale reason is required");
      const run = this.requireRun();
      const before = tasksOf(run);
      const affected = new Set(affectedIds);
      const updatedTasks = before.map((task) => {
        const outcome = task.outcome && typeof task.outcome === "object" && !Array.isArray(task.outcome) ? task.outcome as Record<string, unknown> : undefined;
        const taskIds = Array.isArray(outcome?.affected_ids) ? outcome.affected_ids : [];
        if (!taskIds.some((id) => typeof id === "string" && affected.has(id))) return task;
        return { ...task, status: "stale" as const, stale: true, stale_reason: reason.trim(), updated_at: now() };
      });
      const invalidated = updatedTasks.filter((task, index) => task !== before[index]);
      this.store.updateRun(this.runId, { status: "waiting", phase: "deliberating", tasks: updatedTasks });
      return invalidated;
    });
  }

  async addTask(data: Record<string, unknown>): Promise<ProductRunTask> {
    return this.mutate(() => {
      const run = this.requireRun();
      const id = taskId(data.id);
      const tasks = tasksOf(run);
      if (tasks.some((task) => task.id === id)) throw new Error(`Task already exists: ${id}`);
      const dependencies = list(data.dependencies, "dependencies");
      if (dependencies.includes(id)) throw new Error(`Task cannot depend on itself: ${id}`);
      const task: ProductRunTask = {
        ...data,
        id,
        role: typeof data.role === "string" && data.role.trim() ? data.role.trim() : "specialist",
        description: typeof data.description === "string" && data.description.trim() ? data.description.trim() : id,
        dependencies,
        attempt: 0,
        max_attempts: typeof data.max_attempts === "number" && Number.isInteger(data.max_attempts) && data.max_attempts > 0 ? data.max_attempts : 2,
        status: "pending",
        requirements_baseline: run.requirements_baseline,
        stale: false,
        created_at: now(),
        updated_at: now(),
      };
      this.store.updateRun(this.runId, { tasks: [...tasks, task] });
      return task;
    });
  }

  async startTask(id: string): Promise<ProductRunTask> {
    return this.mutate(() => {
      const run = this.requireRun();
      const task = findTask(run, taskId(id));
      if (task.status === "running") return task;
      if (task.status === "completed") throw new Error(`Task is already complete: ${id}`);
      if (task.status === "stale") throw new Error(`Task is stale and must be retried: ${id}`);
      const tasks = tasksOf(run);
      const missing = task.dependencies.filter((dependency) => !tasks.some((item) => item.id === dependency));
      if (missing.length > 0) throw new Error(`Task ${id} has missing dependencies: ${missing.join(", ")}`);
      const blocked = task.dependencies.filter((dependency) => tasks.some((item) => item.id === dependency && item.status !== "completed"));
      if (blocked.length > 0) throw new Error(`Task ${id} is waiting on: ${blocked.join(", ")}`);
      if (task.attempt >= task.max_attempts) throw new Error(`Task ${id} has exhausted its retry budget`);
      const updated = { ...task, attempt: task.attempt + 1, status: "running" as const, stale: false, started_at: now(), updated_at: now() };
      this.store.updateRun(this.runId, {
        status: "running",
        phase: "fanout",
        tasks: tasks.map((item) => item.id === task.id ? updated : item),
      });
      return updated;
    });
  }

  async completeTask(id: string, outcome: ProductTaskOutcome): Promise<ProductRunTask> {
    return this.mutate(() => {
      const run = this.requireRun();
      const task = findTask(run, taskId(id));
      if (!outcome || !["resolved", "needs_deliberation", "blocked", "failed"].includes(outcome.status)) throw new Error("Invalid task outcome status");
      if (typeof outcome.summary !== "string" || !outcome.summary.trim()) throw new Error("Task outcome summary is required");
      const resultBaseline = outcome.requirements_baseline === undefined ? task.requirements_baseline : outcome.requirements_baseline;
      const stale = resultBaseline !== run.requirements_baseline;
      if (task.status !== "running" && task.status !== "completed") throw new Error(`Task is not running: ${id}`);
      const status: ProductTaskStatus = stale
        ? "stale"
        : outcome.status === "blocked"
          ? "blocked"
          : outcome.status === "failed"
            ? "failed"
            : "completed";
      const updated = {
        ...task,
        status,
        stale,
        outcome: { ...outcome, summary: outcome.summary.trim(), requirements_baseline: resultBaseline },
        ...(stale ? { stale_reason: `Result baseline ${String(resultBaseline)} does not match run baseline ${String(run.requirements_baseline)}` } : {}),
        completed_at: now(),
        updated_at: now(),
      };
      const nextTasks = tasksOf(run).map((item) => item.id === task.id ? updated : item);
      const allComplete = nextTasks.length > 0 && nextTasks.every((item) => item.status === "completed" && !item.stale);
      const attention = status === "blocked" || status === "failed" || status === "stale";
      this.store.updateRun(this.runId, {
        status: allComplete ? "synthesizing" : attention ? "waiting" : "running",
        phase: allComplete ? "synthesis" : attention ? "deliberating" : "fanout",
        tasks: nextTasks,
      });
      return updated as ProductRunTask;
    });
  }

  async retryTask(id: string, reason?: string): Promise<ProductRunTask> {
    return this.mutate(() => {
      const run = this.requireRun();
      const task = findTask(run, taskId(id));
      if (!["failed", "blocked", "stale"].includes(task.status)) throw new Error(`Task is not retryable: ${id}`);
      if (task.attempt >= task.max_attempts) throw new Error(`Task ${id} has exhausted its retry budget`);
      const updated = {
        ...task,
        status: "pending" as const,
        stale: false,
        ...(reason?.trim() ? { retry_reason: reason.trim() } : {}),
        updated_at: now(),
      };
      this.store.updateRun(this.runId, { status: "running", phase: "fanout", tasks: tasksOf(run).map((item) => item.id === task.id ? updated : item) });
      return updated;
    });
  }

  async markTaskStale(ids: string[], reason: string): Promise<ProductRunTask[]> {
    return this.mutate(() => {
      if (!Array.isArray(ids) || ids.length === 0) throw new Error("At least one task id is required");
      if (typeof reason !== "string" || !reason.trim()) throw new Error("Stale reason is required");
      const run = this.requireRun();
      const wanted = new Set(ids.map(taskId));
      const updatedTasks = tasksOf(run).map((task) => wanted.has(task.id)
        ? { ...task, status: "stale" as const, stale: true, stale_reason: reason.trim(), updated_at: now() }
        : task);
      const updated = updatedTasks.filter((task) => wanted.has(task.id));
      if (updated.length !== wanted.size) throw new Error("One or more tasks were not found");
      this.store.updateRun(this.runId, { status: "waiting", phase: "deliberating", tasks: updatedTasks });
      return updated;
    });
  }

  join(): ProductRunJoin {
    const run = this.requireRun();
    const tasks = tasksOf(run);
    const completed = tasks.filter((task) => task.status === "completed" && !task.stale);
    const ready = tasks.filter((task) => task.status === "pending" && task.dependencies.every((dependency) => completed.some((item) => item.id === dependency)));
    const running = tasks.filter((task) => task.status === "running" || task.status === "waiting");
    const blocked = tasks.filter((task) => task.status === "blocked");
    const stale = tasks.filter((task) => task.status === "stale" || task.stale);
    const failed = tasks.filter((task) => task.status === "failed");
    return {
      run_id: run.id,
      run_status: run.status,
      phase: run.phase,
      task_count: tasks.length,
      completed_task_ids: completed.map((task) => task.id),
      ready_task_ids: ready.map((task) => task.id),
      running_task_ids: running.map((task) => task.id),
      blocked_task_ids: blocked.map((task) => task.id),
      stale_task_ids: stale.map((task) => task.id),
      failed_task_ids: failed.map((task) => task.id),
      can_synthesize: tasks.length > 0 && completed.length === tasks.length,
      needs_attention: blocked.length > 0 || stale.length > 0 || failed.length > 0,
    };
  }

  async resume(): Promise<ProductRunJoin> {
    await this.mutate(() => {
      const run = this.requireRun();
      const tasks = tasksOf(run).map((task) => task.status === "running" || task.status === "waiting"
        ? { ...task, status: "pending" as const, resumed_at: now(), updated_at: now() }
        : task);
      this.store.updateRun(this.runId, { status: "running", phase: "fanout", tasks });
    });
    return this.join();
  }

  async setPhase(phase: ProductRunRecord["phase"], status?: ProductRunRecord["status"]): Promise<ProductRunRecord> {
    return this.mutate(() => this.store.updateRun(this.runId, { phase, ...(status ? { status } : {}) }));
  }

  private requireRun(): ProductRunRecord {
    const run = this.store.getRun(this.runId);
    if (!run) throw new Error(`Run not found: ${this.runId}`);
    return run;
  }

  private mutate<T>(operation: () => T | Promise<T>): Promise<T> {
    return withRunMutationLock(`${this.store.directory}\u0000${this.runId}`, operation);
  }
}
