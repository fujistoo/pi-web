import { NextResponse } from "next/server";
import { jsonResponse } from "@/lib/json-response";
import {
  attachSessionProjectInfo,
  getSessionListVersion,
  listAllSessions,
  listSessionSummaries,
  mergeSessionLists,
} from "@/lib/session-reader";
import { getExistingAgentWorkerInfos } from "@/lib/agent-worker-client";
import {
  getCompletionNotificationSuppressedRpcSessionIds,
  getRpcSessionInfos,
  getRunningRpcSessionIds,
} from "@/lib/rpc-manager";
import { startServerPerf } from "@/lib/perf";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const perf = startServerPerf("GET /api/sessions");
  try {
    const searchParams = new URL(req.url).searchParams;
    const force = searchParams.get("force") === "1";
    // `summary=1` serves header/stat metadata so the sidebar can paint without
    // waiting for every session transcript to be parsed.
    const summary = searchParams.get("summary") === "1";
    perf?.span("start");
    const persistedSessionsPromise = summary
      ? listSessionSummaries()
      : listAllSessions({ force });
    // Capture before awaiting: mutations during the scan still require a later refresh.
    const sessionListVersion = getSessionListVersion();
    const [persistedSessions, workerState] = await Promise.all([
      persistedSessionsPromise,
      (async () => {
        try {
          const response = await getExistingAgentWorkerInfos();
          if (!response) return null;
          if (!response.ok) return null;
          return await response.json() as {
            sessions?: import("@/lib/types").SessionInfo[];
            runningSessionIds?: string[];
            completionNotificationSuppressedSessionIds?: string[];
          };
        } catch {
          return null;
        }
      })(),
    ]);
    const localState = getRpcSessionInfos();
    const runtimeSessions = mergeSessionLists(workerState?.sessions ?? [], localState);
    perf?.span("scan+projects");
    const sessions = mergeSessionLists(persistedSessions, await attachSessionProjectInfo(runtimeSessions));
    const runningSessionIds = new Set([
      ...(workerState?.runningSessionIds ?? []),
      ...getRunningRpcSessionIds(),
    ]);
    const completionNotificationSuppressedSessionIds = new Set([
      ...(workerState?.completionNotificationSuppressedSessionIds ?? []),
      ...getCompletionNotificationSuppressedRpcSessionIds(),
    ]);
    const payload = {
      sessions,
      sessionListVersion,
      runningSessionIds: [...runningSessionIds],
      completionNotificationSuppressedSessionIds: [...completionNotificationSuppressedSessionIds],
    };
    const options = { headers: { "Cache-Control": "no-store" } };
    return perf?.attach(jsonResponse(req, payload, options)) ?? jsonResponse(req, payload, options);
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
