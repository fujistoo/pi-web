import { NextResponse } from "next/server";
import { getPixelAgentsOffice } from "@/lib/pixel-agents";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const request = new URL(req.url);
  const sessionId = request.searchParams.get("sessionId") ?? undefined;
  return NextResponse.json(getPixelAgentsOffice(undefined, sessionId), {
    headers: { "Cache-Control": "no-store" },
  });
}
