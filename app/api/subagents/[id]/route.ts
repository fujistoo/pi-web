import { NextResponse } from "next/server";
import {
  AgentWorkerUnavailableError,
  getExistingAgentWorkerSubagent,
  sendExistingAgentWorkerSubagentCommand,
} from "@/lib/agent-worker-client";
import {
  abortSubagent,
  getSubagentRun,
  steerSubagent,
} from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const response = await getExistingAgentWorkerSubagent(id);
    if (response && response.status !== 404) {
      const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      return NextResponse.json(payload, { status: response.status });
    }
    const run = await getSubagentRun(id);
    return NextResponse.json(run ? { run } : { error: "Subagent not found" }, { status: run ? 200 : 404 });
  } catch (error) {
    if (error instanceof AgentWorkerUnavailableError) {
      return NextResponse.json({ error: error.message, code: "agent_worker_unavailable" }, { status: 503 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = await req.json() as { action?: unknown; message?: unknown };
    if (body.action === "steer") {
      if (typeof body.message !== "string" || !body.message.trim()) {
        return NextResponse.json({ error: "message required" }, { status: 400 });
      }
    } else if (body.action !== "abort") {
      return NextResponse.json({ error: "action must be steer or abort" }, { status: 400 });
    }
    const response = await sendExistingAgentWorkerSubagentCommand(id, body);
    if (!response) {
      if (body.action === "steer") await steerSubagent(id, body.message as string);
      else await abortSubagent(id);
      return NextResponse.json({ ok: true, run: await getSubagentRun(id) });
    }
    if (response.status !== 404) {
      const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      return NextResponse.json(payload, { status: response.status });
    }
    if (body.action === "steer") await steerSubagent(id, body.message as string);
    else await abortSubagent(id);
    return NextResponse.json({ ok: true, run: await getSubagentRun(id) });
  } catch (error) {
    if (error instanceof AgentWorkerUnavailableError) {
      return NextResponse.json({ error: error.message, code: "agent_worker_unavailable" }, { status: 503 });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message.includes("not running") ? 409 : 500 });
  }
}
