import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SERVER_DIR = join(homedir(), ".pixel-agents");
const REGISTRY_DIR = join(SERVER_DIR, "servers");
const LEGACY_SERVER = join(SERVER_DIR, "server.json");
const producerId = randomUUID();
let sequence = 0;
let delivery = Promise.resolve();

type ServerTarget = {
  port: number;
  pid: number;
  token: string;
  providerId?: string;
  servesSpa?: boolean;
};

function isLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isTarget(value: unknown): value is ServerTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const target = value as Partial<ServerTarget>;
  return Number.isInteger(target.port) && target.port! > 0 && target.port! <= 65535
    && Number.isInteger(target.pid) && target.pid! > 0
    && typeof target.token === "string" && target.token.length > 0
    && (target.providerId === undefined || typeof target.providerId === "string")
    && (target.servesSpa === undefined || typeof target.servesSpa === "boolean");
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function readTargets(): ServerTarget[] {
  const targets: ServerTarget[] = [];
  try {
    for (const file of readdirSync(REGISTRY_DIR)) {
      if (!file.endsWith(".json")) continue;
      const value = readJson(join(REGISTRY_DIR, file));
      if (isTarget(value) && isLive(value.pid) && value.providerId === "pi") targets.push(value);
    }
  } catch {
    // The registry is optional; Pi should run normally when Pixel Agents is off.
  }
  if (targets.length > 0) return targets;

  const legacy = readJson(LEGACY_SERVER);
  return isTarget(legacy) && isLive(legacy.pid) && legacy.providerId === "pi" ? [legacy] : [];
}

function sanitizeArgs(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const allowed = [
    "file_path",
    "path",
    "command",
    "pattern",
    "query",
    "description",
    "name",
    "cwd",
    "run_in_background",
  ];
  const result: Record<string, unknown> = {};
  for (const key of allowed) {
    const item = source[key];
    if (typeof item === "string") result[key] = item.slice(0, 500);
    else if (typeof item === "boolean" || typeof item === "number") result[key] = item;
  }
  return result;
}

function subagentMetadata(ctx: ExtensionContext): Record<string, unknown> {
  const entry = ctx.sessionManager
    .getEntries()
    .find((item) => item.type === "custom" && item.customType === "pi-web:subagent");
  if (!entry || entry.type !== "custom" || !entry.data || typeof entry.data !== "object") return {};

  const data = entry.data as Record<string, unknown>;
  const parentSessionId = typeof data.parentSessionId === "string" ? data.parentSessionId : undefined;
  const description = typeof data.description === "string" ? data.description : undefined;
  if (!parentSessionId) return {};
  return {
    parent_session_id: parentSessionId.slice(0, 200),
    ...(description ? { agent_name: description.slice(0, 200) } : {}),
  };
}

function send(ctx: ExtensionContext, eventName: string, extra: Record<string, unknown> = {}): void {
  const payload = JSON.stringify({
    session_id: ctx.sessionManager.getSessionId(),
    hook_event_name: "Pi",
    pi_event: eventName,
    producer_id: producerId,
    seq: ++sequence,
    cwd: ctx.cwd,
    ...extra,
  });

  delivery = delivery.then(async () => {
    await Promise.all(readTargets().map(async (target) => {
      try {
        await fetch(`http://127.0.0.1:${target.port}/api/hooks/pi`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${target.token}`,
          },
          body: payload,
          signal: AbortSignal.timeout(2000),
        });
      } catch {
        // Pixel Agents is optional. A stopped or unreachable office must never
        // affect the Pi run that produced this event.
      }
    }));
  }).catch(() => {
    // Keep the queue alive after an unexpected transport failure.
  });
}

export default function pixelAgentsExtension(pi: ExtensionAPI): void {
  pi.on("session_start", (event, ctx) => {
    send(ctx, "session_start", { reason: event.reason, ...subagentMetadata(ctx) });
  });

  pi.on("agent_start", (_event, ctx) => {
    send(ctx, "agent_start");
  });

  pi.on("tool_execution_start", (event, ctx) => {
    send(ctx, "tool_execution_start", {
      tool_call_id: event.toolCallId,
      tool_name: event.toolName,
      tool_input: sanitizeArgs(event.args),
    });
  });

  pi.on("tool_execution_end", (event, ctx) => {
    send(ctx, "tool_execution_end", {
      tool_call_id: event.toolCallId,
    });
  });

  pi.on("agent_settled", (_event, ctx) => {
    send(ctx, "agent_settled");
  });

  pi.on("session_shutdown", (event, ctx) => {
    send(ctx, "session_shutdown", { reason: event.reason });
  });
}

export const __test = { isTarget, sanitizeArgs, readTargets };
