import { NextResponse } from "next/server";
import { linkIdeaWorkItem } from "@/lib/initiative-governance";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ ideaKey: string }> },
) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const { ideaKey } = await context.params;
  if (!/^ZTK-\d+$/.test(ideaKey)) {
    return NextResponse.json({ error: "A valid ZTK idea key is required." }, { status: 400 });
  }
  try {
    const body = await request.json() as { workItemKey?: unknown };
    if (typeof body.workItemKey !== "string" || !/^[A-Z][A-Z0-9_]+-\d+$/.test(body.workItemKey)) {
      return NextResponse.json({ error: "A valid Jira work item key is required." }, { status: 400 });
    }
    await linkIdeaWorkItem(ideaKey, body.workItemKey);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to link the Jira work item to the idea." },
      { status: 502 },
    );
  }
}
