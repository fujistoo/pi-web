import { NextResponse } from "next/server";
import { existsSync } from "fs";
import { allowFileRoot } from "@/lib/file-access";
import { invalidateSessionListCache } from "@/lib/session-reader";
import {
  AgentWorkerUnavailableError,
  createAgentWorkerSession,
} from "@/lib/agent-worker-client";

// POST /api/agent/new  body: { cwd: string; type: string; message?: string; ... }
// The agent worker owns the runtime so a Pi Web restart cannot interrupt it.
export async function POST(req: Request) {
  let commandType: string | undefined;
  let promptAccepted = false;
  try {
    const body = await req.json() as { cwd?: unknown; type?: unknown; [key: string]: unknown };
    commandType = typeof body.type === "string" ? body.type : undefined;
    const { cwd } = body;

    if (!cwd || typeof cwd !== "string") {
      return NextResponse.json({
        error: "cwd is required",
        ...(commandType === "prompt" ? { code: "prompt_rejected", accepted: false } : {}),
      }, { status: 400 });
    }
    if (!existsSync(cwd)) {
      return NextResponse.json({
        error: `Directory does not exist: ${cwd}`,
        ...(commandType === "prompt" ? { code: "prompt_rejected", accepted: false } : {}),
      }, { status: 400 });
    }

    const response = await createAgentWorkerSession(body);
    const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    if (!response.ok) {
      return NextResponse.json({
        ...payload,
        ...(commandType === "prompt" ? { code: "prompt_rejected", accepted: false } : {}),
      }, { status: response.status });
    }

    allowFileRoot(cwd);
    invalidateSessionListCache();
    promptAccepted = commandType === "prompt";
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
