import { NextResponse } from "next/server";
import { searchProjectWorkItems } from "@/lib/initiative-governance";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get("projectId")?.trim();
  const query = searchParams.get("q")?.trim();
  if (!projectId || !query) {
    return NextResponse.json({ items: [] }, { headers: { "Cache-Control": "no-store" } });
  }
  if (projectId.length > 500 || query.length > 200) {
    return NextResponse.json(
      { error: "Project ID or search query is too long." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    return NextResponse.json(
      { items: await searchProjectWorkItems(projectId, query) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to search Jira work items." },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
