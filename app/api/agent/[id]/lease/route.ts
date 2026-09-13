import { NextResponse } from "next/server";
import {
  AgentWorkerUnavailableError,
  renewExistingAgentWorkerLease,
} from "@/lib/agent-worker-client";

// POST /api/agent/[id]/lease - Renew selected-session worker leases.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const response = await renewExistingAgentWorkerLease(id);
    if (!response) {
      return NextResponse.json({ renewed: 0, code: "agent_worker_unavailable" }, {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      });
    }
    const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    return NextResponse.json(payload, {
      status: response.status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof AgentWorkerUnavailableError) {
      return NextResponse.json({ renewed: 0, code: "agent_worker_unavailable" }, { status: 503 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
