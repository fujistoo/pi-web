import { NextResponse } from "next/server";
import { connectExistingAgentWorkerEvents } from "@/lib/agent-worker-client";

export const dynamic = "force-dynamic";

// GET /api/agent/[id]/events - Proxy the agent worker's SSE stream.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (req.signal.aborted) return new Response(null, { status: 204 });

  try {
    const response = await connectExistingAgentWorkerEvents(id, req);
    if (!response) return new Response(null, { status: 204 });
    return new Response(response.body, {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("Content-Type") ?? "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
