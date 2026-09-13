import { NextResponse } from "next/server";
import {
  AgentWorkerUnavailableError,
  sendAgentWorkerCommand,
} from "@/lib/agent-worker-client";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const response = await sendAgentWorkerCommand(id, { type: "auto_name" });
    const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    return NextResponse.json(payload?.data ?? payload, { status: response.status });
  } catch (error) {
    if (error instanceof AgentWorkerUnavailableError) {
      return NextResponse.json({ error: error.message, code: "agent_worker_unavailable" }, { status: 503 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
