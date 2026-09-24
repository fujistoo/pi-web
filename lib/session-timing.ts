interface TimingEntry {
  id?: string;
  type: string;
  timestamp: string;
  message?: { role?: string; content?: unknown };
}

export interface SessionTaskTiming {
  /** One user prompt/turn, in append order. */
  index: number;
  /** The user-message entry anchoring this task. */
  entryId?: string;
  activeMs: number;
  modelMs: number;
  toolMs: number;
}

export interface SessionTiming {
  /** Estimated agent-active time across the whole session file. */
  totalActiveMs: number;
  /** Time waiting for model responses, including retries and compaction. */
  modelMs: number;
  /** Time spent executing tool calls. */
  toolMs: number;
  /** Breakdown by user prompt. */
  tasks: SessionTaskTiming[];
}

/**
 * Estimate active wall-clock time from the append-only session log.
 *
 * Raw entries preserve compacted history and every executed branch exactly
 * once. Gaps ending at user messages are treated as human idle. User-initiated
 * bash entries are also boundaries because the log records only their finish
 * time, so counting the incoming gap could include arbitrary human idle.
 */
export function computeSessionTiming(entries: readonly TimingEntry[]): SessionTiming {
  let totalActiveMs = 0;
  let modelMs = 0;
  let toolMs = 0;
  let previousTimestamp: number | undefined;
  let inToolPhase = false;
  let currentTask: SessionTaskTiming | undefined;
  const tasks: SessionTaskTiming[] = [];

  for (const entry of entries) {
    if (!isTimingEntry(entry.type)) continue;

    const timestamp = Date.parse(entry.timestamp);
    if (!Number.isFinite(timestamp)) continue;

    const role = entry.type === "message" ? entry.message?.role : undefined;
    if (role === "user") {
      if (currentTask) tasks.push(currentTask);
      currentTask = {
        index: tasks.length + 1,
        ...(entry.id ? { entryId: entry.id } : {}),
        activeMs: 0,
        modelMs: 0,
        toolMs: 0,
      };
      previousTimestamp = timestamp;
      inToolPhase = false;
      continue;
    }
    if (role === "bashExecution") {
      if (currentTask) {
        tasks.push(currentTask);
        currentTask = undefined;
      }
      previousTimestamp = timestamp;
      inToolPhase = false;
      continue;
    }

    if (previousTimestamp !== undefined && timestamp > previousTimestamp) {
      const elapsed = timestamp - previousTimestamp;
      const intervalIsTool = inToolPhase && role === "toolResult";
      totalActiveMs += elapsed;
      if (intervalIsTool) toolMs += elapsed;
      else modelMs += elapsed;
      if (currentTask) {
        currentTask.activeMs += elapsed;
        if (intervalIsTool) currentTask.toolMs += elapsed;
        else currentTask.modelMs += elapsed;
      }
    }
    previousTimestamp = timestamp;

    if (role === "assistant") {
      // The interval ending at an assistant message is model time. A tool-call
      // assistant message starts the tool phase for the following results.
      inToolPhase = hasToolCall(entry.message?.content);
    } else if (role === "toolResult") {
      // Keep the phase across parallel/multiple tool results. The next
      // assistant message switches the following interval back to model time.
      inToolPhase = true;
    }
  }

  if (currentTask) tasks.push(currentTask);
  return { totalActiveMs, modelMs, toolMs, tasks };
}

export function computeSessionTotalActiveMs(entries: readonly TimingEntry[]): number {
  return computeSessionTiming(entries).totalActiveMs;
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return "0s";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function hasToolCall(content: unknown): boolean {
  return Array.isArray(content) && content.some((block) => (
    block !== null
    && typeof block === "object"
    && (block as { type?: unknown }).type === "toolCall"
  ));
}

function isTimingEntry(type: string): boolean {
  return type === "message"
    || type === "compaction"
    || type === "branch_summary"
    || type === "custom_message";
}
