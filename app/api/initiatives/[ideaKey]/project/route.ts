import { NextResponse } from "next/server";
import { createProjectForIdea } from "@/lib/initiative-governance";
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
    return NextResponse.json(await createProjectForIdea(ideaKey));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to create an Atlassian Project." },
      { status: 502 },
    );
  }
}
