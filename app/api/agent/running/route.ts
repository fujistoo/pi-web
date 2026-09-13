import { NextResponse } from "next/server";
import { getSessionListVersion } from "@/lib/session-reader";
import { getExistingAgentWorkerRunning } from "@/lib/agent-worker-client";
import {
  getCompletionNotificationSuppressedRpcSessionIds,
  getRunningRpcSessionIds,
} from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
export async function GET() {
  try {
    const response = await getExistingAgentWorkerRunning();
    const payload = response?.ok
      ? await response.json() as { runningSessionIds?: string[]; completionNotificationSuppressedSessionIds?: string[] }
      : {};
    payload.runningSessionIds = [...new Set([
      ...(payload.runningSessionIds ?? []),
      ...getRunningRpcSessionIds(),
    ])];
    payload.completionNotificationSuppressedSessionIds = [...new Set([
      ...(payload.completionNotificationSuppressedSessionIds ?? []),
      ...getCompletionNotificationSuppressedRpcSessionIds(),
    ])];
    return NextResponse.json(
      { sessionListVersion: getSessionListVersion(), ...payload },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
