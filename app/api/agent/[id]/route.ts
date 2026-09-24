import { NextResponse } from "next/server";
import {
  AgentWorkerUnavailableError,
  getExistingAgentWorkerState,
  hasAgentWorkerDescriptor,
  sendAgentWorkerCommand,
} from "@/lib/agent-worker-client";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";

// POST /api/agent/[id] - Send a command to the agent worker.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let commandType: string | undefined;
  let promptAccepted = false;

  try {
    const body = await req.json() as { type: string; [key: string]: unknown };
    commandType = typeof body.type === "string" ? body.type : undefined;
    const requestedToolNames = body.toolNames;
    if (
      requestedToolNames !== undefined
      && (!Array.isArray(requestedToolNames) || requestedToolNames.some((name) => typeof name !== "string"))
    ) {
      throw new Error("toolNames must be an array of strings");
    }

    const response = await sendAgentWorkerCommand(id, body);
    const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    if (!response.ok) {
      return NextResponse.json({
        ...payload,
        ...(body.type === "prompt" ? { code: "prompt_rejected", accepted: false } : {}),
      }, { status: response.status });
    }
    promptAccepted = body.type === "prompt";
    return NextResponse.json(payload);
  } catch (error) {
    if (error instanceof AgentWorkerUnavailableError) {
      return NextResponse.json({
        error: error.message,
        code: "agent_worker_unavailable",
        ...(commandType === "prompt" ? { accepted: false } : {}),
      }, { status: 503 });
    }
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
      ...(commandType === "prompt" && !promptAccepted
        ? { code: "prompt_rejected", accepted: false }
        : {}),
    }, { status: 500 });
  }
}

// GET /api/agent/[id] - Get current agent state.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const workerWasAdvertised = hasAgentWorkerDescriptor();
    const response = await getExistingAgentWorkerState(id);
    if (response) {
      const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      if (response.ok || response.status !== 404) return NextResponse.json(payload, { status: response.status });
    }
    const localSession = getRpcSession(id);
    if (localSession?.isAlive()) {
      return NextResponse.json({ running: true, state: await localSession.send({ type: "get_state" }) });
    }
    if (!response && workerWasAdvertised) {
      return NextResponse.json({ error: "The agent worker is reconnecting", code: "agent_worker_unavailable", running: "unknown" }, { status: 503 });
    }
    if (await resolveSessionPath(id)) return NextResponse.json({ running: false });
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  } catch (error) {
    if (error instanceof AgentWorkerUnavailableError) {
      return NextResponse.json({
        error: error.message,
        code: "agent_worker_unavailable",
        running: "unknown",
      }, { status: 503 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
