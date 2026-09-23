import { NextResponse } from "next/server";
import { fetchGovernanceCandidates } from "@/lib/initiative-governance";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const candidates = await fetchGovernanceCandidates();
    return NextResponse.json(
      { candidates, refreshedAt: new Date().toISOString() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to refresh ZTK ideas." },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
