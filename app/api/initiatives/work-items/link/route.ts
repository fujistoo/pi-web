import { NextResponse } from "next/server";
import { linkProjectWorkItem } from "@/lib/initiative-governance";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = await request.json() as { projectId?: unknown; workItemId?: unknown };
    if (
      typeof body.projectId !== "string"
      || typeof body.workItemId !== "string"
      || !body.projectId.trim()
      || !body.workItemId.trim()
      || body.projectId.length > 500
      || body.workItemId.length > 500
    ) {
      return NextResponse.json({ error: "A project and Jira work item are required." }, { status: 400 });
    }
    return NextResponse.json(await linkProjectWorkItem(body.projectId, body.workItemId));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to link the Jira work item." },
      { status: 502 },
    );
  }
}
