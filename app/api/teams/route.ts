import { listTeamFeatures, TeamFeatureStore } from "@/lib/team-state";
import { requireTeamCwd, teamError } from "@/lib/team-api";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const cwd = await requireTeamCwd(new URL(request.url).searchParams.get("cwd"));
    return Response.json({ teams: listTeamFeatures(cwd) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return teamError(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { cwd?: unknown; feature?: unknown; main?: unknown };
    const cwd = await requireTeamCwd(body.cwd);
    if (typeof body.feature !== "string") throw new Error("feature is required");
    if (!body.main || typeof body.main !== "object" || Array.isArray(body.main)) throw new Error("main is required");
    const team = new TeamFeatureStore(cwd, body.feature).create(body.main as { id: string; session_id?: string; worktree?: string });
    return Response.json({ team }, { status: 201 });
  } catch (error) {
    return teamError(error);
  }
}
