import { requireTeamCwd, teamError } from "@/lib/team-api";
import {
  TeamFeatureStore,
  type TeamEscalationReason,
  type TeamLifecycleStatus,
  type TeamTaskStatus,
  type TeamWriteScope,
} from "@/lib/team-state";

type Context = { params: Promise<{ feature: string }> };

async function storeFor(request: Request, context: Context, body?: Record<string, unknown>) {
  const { feature } = await context.params;
  const queryCwd = new URL(request.url).searchParams.get("cwd");
  const cwd = await requireTeamCwd(body?.cwd ?? queryCwd);
  return new TeamFeatureStore(cwd, feature);
}

export async function GET(request: Request, context: Context) {
  try {
    const store = await storeFor(request, context);
    return Response.json({ team: store.read(), cleanup: store.cleanupTargets() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return teamError(error);
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const store = await storeFor(request, context, body);
    switch (body.action) {
      case "add_participant":
        return Response.json({ participant: store.addParticipant(body.participant as {
          id: string; role: "lead" | "member"; parent_id: string; write_scope?: TeamWriteScope; worktree?: string; session_id?: string;
        }) });
      case "write_state":
        return Response.json({ team: store.writeState(String(body.actor_id ?? ""), body.patch as Record<string, unknown>) });
      case "write_source":
        return Response.json({ team: store.writeSource(String(body.actor_id ?? ""), body.patch as Record<string, unknown>) });
      case "add_task":
        return Response.json({ task: store.addTask(body.task as { id: string; title: string; owner_id?: string; dependencies?: string[] }) });
      case "update_task": {
        const patch = body.patch as { status?: TeamTaskStatus; dependencies?: string[]; owner_id?: string | null };
        return Response.json({ task: store.updateTask(String(body.task_id ?? ""), patch) });
      }
      case "send_message":
        return Response.json({ message: store.createDirectMessage(body.message as {
          id?: string; sender_id: string; recipient_id: string; body: string;
        }) }, { status: 202 });
      case "mark_delivery":
        return Response.json({ message: store.markMessageDelivery(
          String(body.message_id ?? ""),
          body.status as "delivered" | "failed",
          typeof body.error === "string" ? body.error : undefined,
        ) });
      case "escalate": {
        const escalation = body.escalation as {
          id?: string; sender_id: string; reason: TeamEscalationReason; message: string; interview?: { title: string; questions: unknown[] };
        };
        return Response.json({ escalation: store.recordEscalation(escalation) }, { status: 201 });
      }
      case "resolve_escalation":
        return Response.json({ escalation: store.resolveEscalation(
          String(body.actor_id ?? ""),
          String(body.escalation_id ?? ""),
          String(body.response ?? ""),
        ) });
      case "transition":
        return Response.json({ team: store.transition(body.status as TeamLifecycleStatus) });
      case "decommission":
        return Response.json(store.decommission(String(body.actor_id ?? "")));
      default:
        return Response.json({ error: "Unknown team action" }, { status: 400 });
    }
  } catch (error) {
    return teamError(error);
  }
}
