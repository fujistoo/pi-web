import { NextResponse } from "next/server";
import {
  getExistingAgentWorkerState,
  hasAgentWorkerDescriptor,
} from "@/lib/agent-worker-client";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";

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
      if (response.ok || response.status !== 404) {
        return NextResponse.json(payload, {
          status: response.status,
          headers: { "Cache-Control": "no-store" },
        });
      }
    }
    const localSession = getRpcSession(id);
    if (localSession?.isAlive()) {
      return NextResponse.json({ running: true, state: await localSession.send({ type: "get_state" }) }, {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (!response && workerWasAdvertised) {
      return NextResponse.json({ error: "The agent worker is reconnecting", code: "agent_worker_unavailable", running: "unknown" }, {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (await resolveSessionPath(id)) {
      return NextResponse.json({ running: false }, { headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ error: "Session not found" }, {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
