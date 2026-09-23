import {
  isEventIncludedInSnapshot,
  toClientAgentEvent,
  type AgentEventLike,
} from "./agent-event-wire";
import { acquireSessionLivenessLease } from "./session-liveness";

export interface AgentEventStreamSession {
  readonly isStreaming: boolean;
  readonly isPromptRunning?: boolean;
  readonly isBashRunning?: boolean;
  readonly isCompacting?: boolean;
  readonly running?: boolean;
  readonly streamingMessage: unknown;
  readonly currentEventSequence?: number;
  readonly extensionUiState?: {
    statuses: Array<{ key: string; text: string }>;
    widgets: Array<{ key: string; lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
  };
  getEventsSince?(sequence: number): Array<{ sequence: number; event: AgentEventLike }>;
  onEvent(listener: (event: AgentEventLike, sequence?: number) => void): () => void;
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const CLOSER_REGISTRY: symbol = Symbol.for("pi-web.agentEventStreamClosers");
type StreamCloser = (closeController: boolean | "error") => void;
const activeStreamClosers: Set<StreamCloser> =
  ((globalThis as Record<symbol, Set<StreamCloser>>)[CLOSER_REGISTRY] ??= new Set<StreamCloser>());

export function closeAllAgentEventStreams(): void {
  for (const close of [...activeStreamClosers]) {
    try { close("error"); } catch { /* stream already closed */ }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Open the SSE transport immediately, then publish the session snapshot only
 * after the agent is ready and its event listener has been installed.
 */
export function createAgentEventStream(
  req: Request,
  sessionId: string,
  sessionPromise: Promise<AgentEventStreamSession>,
): ReadableStream<Uint8Array> {
  let cancelStream: (closeController: boolean | "error") => void = () => {};
  let releaseLease: () => void = () => {};

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let unsubscribe: (() => void) | null = null;
      let abortHandler: (() => void) | null = null;

      const cleanup = (closeController: boolean | "error") => {
        if (closed) return;
        closed = true;
        releaseLease();
        releaseLease = () => {};
        activeStreamClosers.delete(cleanup);
        if (heartbeat !== null) clearInterval(heartbeat);
        unsubscribe?.();
        unsubscribe = null;
        if (abortHandler) req.signal.removeEventListener("abort", abortHandler);
        if (closeController === "error") {
          try { controller.error(new Error("pi-web server shutting down")); } catch { /* already closed */ }
        } else if (closeController) {
          try { controller.close(); } catch { /* stream already closed */ }
        }
      };
      cancelStream = cleanup;
      releaseLease = acquireSessionLivenessLease(sessionId).release;
      activeStreamClosers.add(cleanup);

      const enqueueText = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup(false);
        }
      };
      const encode = (data: unknown, sequence?: number) => {
        enqueueText(`${typeof sequence === "number" && sequence > 0 ? `id: ${sequence}\n` : ""}data: ${JSON.stringify(data)}\n\n`);
      };
      const forwardEvent = (event: AgentEventLike, snapshot: unknown, sequence?: number) => {
        if (isEventIncludedInSnapshot(event, snapshot)) return;
        const clientEvent = toClientAgentEvent(event);
        if (clientEvent) encode(clientEvent, sequence);
      };

      const publishSession = async () => {
        try {
          const session = await sessionPromise;
          if (closed) return;

          const bufferedEvents: Array<{ event: AgentEventLike; sequence?: number }> = [];
          let snapshotPublished = false;
          const handleEvent = (event: AgentEventLike, sequence?: number) => {
            if (!snapshotPublished) {
              bufferedEvents.push({ event, sequence });
              return;
            }
            forwardEvent(event, snapshot, sequence);
          };

          const stopListening = session.onEvent(handleEvent);
          if (closed) {
            stopListening();
            return;
          }
          unsubscribe = stopListening;

          const snapshot = session.streamingMessage;
          const connected: Record<string, unknown> = {
            type: "connected",
            sessionId,
            isStreaming: session.isStreaming,
          };
          if (session.running !== undefined) connected.running = session.running;
          if (session.isPromptRunning !== undefined) connected.isPromptRunning = session.isPromptRunning;
          if (session.isBashRunning !== undefined) connected.isBashRunning = session.isBashRunning;
          if (session.isCompacting !== undefined) connected.isCompacting = session.isCompacting;
          if (session.currentEventSequence !== undefined) connected.eventSequence = session.currentEventSequence;
          if (session.extensionUiState) {
            connected.extensionStatuses = session.extensionUiState.statuses;
            connected.extensionWidgets = session.extensionUiState.widgets;
          }
          encode(connected);

          const after = Number(new URL(req.url).searchParams.get("after") ?? req.headers.get("last-event-id") ?? 0);
          const replayedEvents = Number.isFinite(after) && after > 0
            ? session.getEventsSince?.(after) ?? []
            : [];
          const replayedSequences = new Set<number>();
          for (const record of replayedEvents) {
            replayedSequences.add(record.sequence);
            forwardEvent(record.event, snapshot, record.sequence);
          }
          for (const record of bufferedEvents) {
            if (typeof record.sequence === "number" && replayedSequences.has(record.sequence)) continue;
            forwardEvent(record.event, snapshot, record.sequence);
          }
          if (snapshot !== undefined && snapshot !== null) {
            encode({ type: "message_start", message: snapshot });
          }
          snapshotPublished = true;
        } catch (error) {
          if (closed) return;
          encode({
            type: "startup_error",
            errorMessage: `Failed to start agent: ${errorMessage(error)}`,
          });
          cleanup(true);
        }
      };

      // Attach the rejection handler before checking the request signal. The
      // route may already have started a shared cold-start promise.
      void publishSession();

      abortHandler = () => cleanup(true);
      if (req.signal.aborted) {
        cleanup(true);
        return;
      }
      req.signal.addEventListener("abort", abortHandler, { once: true });

      heartbeat = setInterval(() => enqueueText(":\n\n"), HEARTBEAT_INTERVAL_MS);

      // Force the response headers through without claiming that the agent is
      // ready. The client waits for the later `connected` data event.
      enqueueText(":\n\n");
    },
    cancel() {
      cancelStream(false);
    },
  });
}
