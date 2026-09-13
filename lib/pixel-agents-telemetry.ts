import { randomUUID } from "node:crypto";
import { findPiStandaloneServer } from "./pixel-agents";

export type PixelPiEventName =
  | "session_start"
  | "session_shutdown"
  | "agent_start"
  | "agent_settled"
  | "tool_execution_start"
  | "tool_execution_end";

export type PixelPiEventSender = (
  sessionId: string,
  cwd: string,
  eventName: PixelPiEventName,
  extra?: Record<string, unknown>,
) => void;

type ObservableSession = {
  sessionId: string;
  subscribe(listener: (event: unknown) => void): () => void;
};

const producerId = randomUUID();
let sequence = 0;
let delivery = Promise.resolve();

const TOOL_INPUT_KEYS = [
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

export function sanitizePixelToolInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of TOOL_INPUT_KEYS) {
    const item = source[key];
    if (typeof item === "string") result[key] = item.slice(0, 500);
    else if (typeof item === "boolean" || typeof item === "number") result[key] = item;
  }
  return result;
}

export const sendPixelPiEvent: PixelPiEventSender = (sessionId, cwd, eventName, extra = {}) => {
  const server = findPiStandaloneServer();
  if (!server) return;

  const payload = JSON.stringify({
    session_id: sessionId,
    hook_event_name: "Pi",
    pi_event: eventName,
    producer_id: producerId,
    seq: ++sequence,
    cwd,
    ...extra,
  });

  delivery = delivery.then(async () => {
    try {
      await fetch(`http://127.0.0.1:${server.port}/api/hooks/pi`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${server.token}`,
        },
        body: payload,
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      // Pixel Agents is optional; telemetry must never affect subagent execution.
    }
  }).catch(() => {
    // Keep the queue alive after an unexpected transport failure.
  });
};

export function startPixelPiTelemetry(
  session: ObservableSession,
  options: { cwd: string; parentSessionId: string; agentName: string },
  send: PixelPiEventSender = sendPixelPiEvent,
): (reason?: string) => void {
  let stopped = false;
  send(session.sessionId, options.cwd, "session_start", {
    reason: "startup",
    parent_session_id: options.parentSessionId,
    agent_name: options.agentName,
  });

  const unsubscribe = session.subscribe((raw) => {
    if (stopped || !raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const event = raw as Record<string, unknown>;
    switch (event.type) {
      case "agent_start":
        send(session.sessionId, options.cwd, "agent_start");
        break;
      case "agent_settled":
        send(session.sessionId, options.cwd, "agent_settled");
        break;
      case "tool_execution_start": {
        const toolCallId = event.toolCallId;
        const toolName = event.toolName;
        if (typeof toolCallId !== "string" || typeof toolName !== "string") break;
        send(session.sessionId, options.cwd, "tool_execution_start", {
          tool_call_id: toolCallId,
          tool_name: toolName,
          tool_input: sanitizePixelToolInput(event.args),
        });
        break;
      }
      case "tool_execution_end": {
        const toolCallId = event.toolCallId;
        if (typeof toolCallId !== "string") break;
        send(session.sessionId, options.cwd, "tool_execution_end", {
          tool_call_id: toolCallId,
        });
        break;
      }
      default:
        break;
    }
  });

  return (reason = "completed") => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    send(session.sessionId, options.cwd, "session_shutdown", { reason });
  };
}
